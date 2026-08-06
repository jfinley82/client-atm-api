# client-atm-api

Vercel serverless API (`api/**` → one function per file), TypeScript compiled to
**CommonJS**, Supabase for data, Resend for mail.

---

## RULE: verify on a deployment before merging to production

**A green `npm run gate` does not mean the code works in production.** It cannot.
The gate runs locally against local `node_modules`, where every package is
present on disk. The deployed function contains only what Vercel's bundler
traced as reachable. Nothing that runs locally can see that difference.

This gap caused two production incidents in two consecutive commits. Both had a
clean gate, clean `tsc --noEmit`, and a clean local build.

### The procedure

1. Push the branch and let Vercel build the **preview** deployment.
   (Preview, not production — a failure must not take prod down.)
2. **Exercise the code path you changed** on the preview URL.
3. Check `mcp__Vercel__get_runtime_logs` for that deployment — look for
   `ERR_REQUIRE_ESM`, `ERR_MODULE_NOT_FOUND`, `FUNCTION_INVOCATION_FAILED`.
4. Only then merge, and re-verify the same way on production.

### Step 2 is the one that gets skipped, and it is the whole point

**A status code proves the module loads. It does not prove the path works.**

The second incident returned `405 Method Not Allowed` from the endpoint —
correct, healthy-looking, indistinguishable from a working deploy. The failure
was inside the handler and only fired when a real request reached that branch.
It silently lost a real member's reply.

So: pinging the endpoint is not verification. Verification means the changed
branch actually executes. If it needs a signed webhook, real auth, or an
external trigger you cannot produce, **say so plainly and get a human to trigger
it** — do not substitute a status-code check and call it verified.

### When it matters most

Any change to imports or dependencies, and anything where the runtime
environment differs from local. Adding a package is the highest-risk case in
this repo: see below.

---

## Dependencies: prefer no new package

`tsconfig.json` targets **CommonJS**. That makes ESM-only packages actively
hostile here, and the failure modes are all silent-until-runtime:

- A plain `import` of an ESM-only package compiles fine, then throws
  `ERR_REQUIRE_ESM` **at module load** in production — taking down every route
  in that file, not just the new code.
- `await import(...)` does not fix it: TypeScript downlevels dynamic import to
  the same `require()` when targeting CommonJS.
- Hiding the import from TypeScript (e.g. `new Function('return import("x")')`)
  defeats the compiler *and* Vercel's bundler, which only ships packages it can
  statically see. The package is then absent from the deployed artifact and
  throws `ERR_MODULE_NOT_FOUND` **when the code path runs**.

Before adding a dependency, check `node_modules/<pkg>/package.json` for
`"type": "module"` and the absence of a CJS build. If it's ESM-only, strongly
prefer writing the logic locally — `lib/emailReply.ts` exists because that was
the right call after the third failed workaround.

`vercel.json` `includeFiles` can force-include a package (see
`@sparticuz/chromium`), but that relocates the failure class rather than
removing it.

---

## Testing

- `npm run gate` = `tsc --noEmit` + every `tests/*.test.ts`.
- Tests are plain TypeScript, bundled per-file with esbuild and run in their own
  process (env vars set at module scope would otherwise leak between files).
- Imports in `tests/` **must be relative** (`../lib/foo`). Absolute paths break
  every other clone and CI.
- The gate proves logic. It does not prove packaging or deployment. See the rule
  above.

## Migrations

- `supabase/migrations/NNN_name.sql`, applied by `scripts/migrate.mjs`.
- Validate against production inside `begin; ... rollback;` before applying.
- Use `text` + `CHECK` for fixed value sets, not Postgres enums — widening a
  CHECK is one migration; widening an enum type is not.

## Conventions

- Derive values at read time from raw signals rather than storing computed
  state (see the SLA logic in `lib/support.ts`) so a rule change reprices
  history instead of leaving rows stamped against the old rule.
- Notification emails are best-effort by contract: wrap in try/catch, log, never
  throw. A mail failure must not roll back the write that already succeeded.
- Resend mail uses published templates by alias (`mtm-*`), never inline HTML.
- Webhooks always return 2xx after signature verification, so a transient error
  doesn't trigger a retry storm.
- External webhooks redeliver. Any handler that writes must be idempotent on a
  key from the payload — see `support_ticket_messages.resend_email_id` and its
  partial unique index, and the `alreadyProcessed` path in `appendTicketMessage`.

---

## Gotchas

Things that cost real debugging time here. **Add to this list when you burn time
on something non-obvious** — symptom first, since that's what the next person
will be searching for. Keep entries short; this file loads into every session.

**`ERR_INVALID_ARG_VALUE: The argument 'filename' must be a file URL object … Received undefined`**
A bundled dependency read `import.meta.url` at module scope. esbuild's
`--format=cjs` empties `import.meta` when it inlines a package into the bundle.
Fix: `--packages=external`, so Node loads the real package file and
`import.meta` stays intact. `scripts/run-tests.mjs` does this.

**A test sees a real client / a stub env var it just set is ignored.**
`lib/email.ts` runs `new Resend(process.env.RESEND_API_KEY!)` at module scope,
and ES imports are hoisted above the test file's own `process.env` assignments.
Set env vars first, then reach the module under test through
`await import('../api/...')`. Every test touching the mail path does this.

**A PostgREST `.or()` filter silently matches the wrong rows.**
`or=` is comma-separated, so a comma, paren, or backslash in user input is read
as filter syntax. Strip them before interpolating — `escapeForOr` in
`api/admin/support/tickets.ts`.

**A test mock mis-parses an `.or()` containing `in.(a,b)`.**
Non-greedy `[^)]*` stops at the *inner* paren and truncates the clause. Use a
greedy match anchored to the end of the param: `=\\((.*)\\)(?=&|$)`.

**Git reports unpushed commits right after a successful squash-merge.**
Squash creates a *new* commit on `main`; the feature branch pointer still refers
to the pre-squash commit, so the branch reads as diverged. Nothing is at risk.
Resync with `git checkout -B <branch> origin/main` then push
`--force-with-lease`.

**A member's emailed reply arrives with our whole quoted email appended.**
Gmail wraps the sender address onto its own line mid-header:
`On Mon, … Micro-Training Method <\nnoreply@…> wrote:`. A `/On .* wrote:/`
pattern can't match across that newline. `lib/emailReply.ts` uses `[\s\S]`
throughout for this; `tests/emailReply.test.ts` pins the real email that
exposed it.

**Generated copy arrives as one solid block however many times the prompt asks
for paragraphs.** Look at `lib/phrasing.ts` before touching the prompt. `\n\n`
is two whitespace characters, so a `\s`-matching rule eats it: `/\s{2,}/g → ' '`
flattened every body, and `/\s*[—–]\s*/g → ', '` turned `line\n\n— point` into
`line, point`. Match horizontal whitespace with `[^\S\n]`, never `\s`.
Three prompt hypotheses died against this before anyone read the sanitizer.

**A sanitizer that is "display-only on read" is not.** `sanitizeGenRead` was
described as never written back — but the editor saves what it was handed, so a
GET that flattens plus a save that persists is a write path with extra steps.
A field went `16/6/6` blank lines → `0/0/0` including its `original` snapshot
with character-identical copy, i.e. no regeneration involved. Two consequences:
read-path transforms need the same care as write-path ones, and `original` is
excluded from `sanitizePhrasingDeep`'s walk so a read→save cycle can't launder
mangled copy into the baseline that detects coach edits.

**A comment states the invariant you were about to check, so you don't check it.**
The worst version of a stale comment: one that was TRUE WHEN WRITTEN and quietly
outlived its premise. `bookLegacyPath` said it validated against "the SAME
computation behind `GET /api/calendar/availability`, which is the list the
booking page renders" — true while that path served only MTM's funnel-less page,
false from the moment native-calendar funnels started routing through it, because
a funnel page calls `/api/funnel/availability` and a different engine. The list
and the accept had been answering from two sources for months, wearing a comment
saying they couldn't.
Four instances of this shape surfaced in one day, so treat it as the default
suspicion rather than a curiosity:
- `isSlotOpen` returned false for one reason, so `false -> slot_taken` was safe —
  until availability gating gave it a second.
- `<input type="date">` couldn't express a time, so a date-only post couldn't
  mean "clear the time" — until the form grew a time field.
- A rule was "self-limiting because a form sending datetimes would never trigger
  it" — the form changed, the rule didn't notice.
- The comment above.
**A claim about how the world is, written inside code, is a snapshot with no
expiry date.** When a comment asserts two things agree, that agreement is the
thing to verify, not the reason to skip verifying. Prefer comments that say what
the code DOES and why the tradeoff was made; assertions about a caller you don't
control are the ones that rot. Where the invariant matters, write a test that
compares the two artifacts against each other — `tests/ctaSeam.test.ts` and the
one-resolver assertion in `tests/bookingPage.test.ts` both exist for this.

**An endpoint that 502s "intermittently" on a parameter the caller controls.**
`GET /api/calendar/availability` forwarded `from`/`to` from the query string
unbounded; Zoom's `available_times` rejects any window over 45 days with a 400,
so every request over the limit 502'd — deterministically, not intermittently.
The page asked for 60 days and got a calendar with all 42 cells disabled.
**Probe with the request the client actually sends.** A 14-day probe returned
5/5 at 200 and read as "healthy, transient"; the same endpoint at 60 days failed
every time. When a failure looks flaky, vary the input before concluding it is
upstream flakiness — bracket it (44/45/46 found the limit on its own). Clamping
lives in `lib/schedulerSlots.ts` because the list and the booking check must
never diverge, and this was the third time they had; note `isSchedulerSlotOpen`
re-anchors on the slot rather than truncating, or a far-future slot falls outside
its own validation window and a bookable time gets rejected.

**A size refusal that can't be detected by status code.** Supabase answers an
oversize signed-URL PUT with **HTTP 400 carrying `"statusCode":"413"` in the
body**, so `res.status === 413` is false on exactly the case that needs
handling. The signing endpoints therefore require `size`, so a legitimate
oversize file is refused by *us* with a real 413 before any transfer; storage's
own refusal is then only reachable by a client that declared one size and sent
another. Related: seven endpoints shared the too-large condition and disagreed
about its status (two 413, five 400) — invisible while every message was
readable, live the moment a frontend keys on the status. `lib/rawBody.ts` owns
the number, the message **and** the status; collapsing duplicates in one
dimension just moves the drift into the next one.

**An upload fails as a network error with no status, and the handler's own limit
never fires.** Vercel refuses a serverless request body over ~4.5MB **at the
edge** — the function is never invoked, so no handler code runs and nothing it
would have written is sent. Any `MAX_BYTES` above that is unreachable code
pretending to be a limit; six endpoints here had one (5MB, 10MB, 20MB, and a
6MB whose comment even acknowledged the ceiling). `lib/rawBody.ts` owns the
number now and `tests/uploadLimits.test.ts` fails on any new literal cap.
The tell in timing: an oversized request fails **faster** than a smaller one
succeeds, because it dies before the transfer completes. Bracket one size above
and one below before theorising about the handler — a mechanism that fits the
symptom is not evidence the request ever arrived. Past the cap the frontend's
size check is the only thing that can produce a readable error, because the
server never gets to speak. To actually carry more, the function has to leave
the transfer path: `lib/uploadUrl.ts` mints a signed URL the browser PUTs to
directly. That moves size/mime enforcement onto the bucket, which is why
migration 087 exists — signed URLs without it are an unbounded write endpoint.

**Two renderings of the same thing drift apart, and it looks fine wherever you
test.** The email CTA button is emitted twice — a VML branch only Outlook draws,
an anchor branch everyone else draws — and the VML shipped 44px tall against the
anchor's rendered 48px, invisible from any client we could check. When two
branches must render the same control for audiences that can't see each other,
assert them **against each other**, not against constants: `tests/ctaSeam.test.ts`
extracts both labels from the same output and compares them, and recomputes the
anchor's height from its emitted style (`padding*2 + line-height`) to check the
VML matches. Same shape as the button colour being one parameter, never two
defaults — if the branches *can* disagree, they eventually will.
