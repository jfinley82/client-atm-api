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

## Merging

Backend work in this repo **merges by default** once `npm run gate` is green.
Report after; do not ask first.

Every unmerged branch costs a round. The other builder reads `main`, correctly
finds a different world, and reports a contract mismatch that is really a merge
that never happened. That happened twice on 2026-08-06 — the six-commit quiz
chain (which is where `api/quiz/questions.ts`, `gap.focus/resolution/disputed`
and `MATERIAL_MARGIN` all arrived) and then `af732f3`, where nothing on `main`
read `quiz_responses` — and each time the frontend was right and the branch was
the problem.

**Still stop and ask** for:

- **Visible behaviour changes.** The `charge-demo` "bookable → not bookable"
  flip is the shape. If a coach or a lead would notice, ask.
- **Migrations and production data writes.** Validate in `begin; … rollback;`
  first and say what is about to be applied. `record_quiz_result` needing to be
  an upsert is why: the gate was green and the design was still wrong, and only
  production had the `UNIQUE(user_id)` constraint that proved it.
- **Anything in `client-atm-frontend`.** Another session's repo.
- **Anything you expect to be overruled on.** State the reasoning rather than
  deciding quietly; the `stated_challenge` decline was right and would have been
  invisible otherwise.

Confirm a merge landed **by capability, not by SHA**. Squash merges mean the
branch SHA never appears on `main`. Check that the endpoint answers, not that
the commit is an ancestor.

---

## Verification

### Fix the property, not the example

When a defect arrives as an example, it is not fixed until the **property** it
violates is written down in words, in the commit and in the test.

"A coach with a perfect offer must not be told their offer is unclear" is an
example, and it produces a guard against one row. "The results screen may not
assert something the scores contradict" is the property, and it produces a guard
against the class. If the property cannot be stated, the fix is not understood
yet, and shipping it is a guess wearing a green check.

On 2026-08-06 the same gap guard leaked three times. Each fix aimed at the last
example, and each time the carve-out was where it leaked next.

### A sweep is only as good as its predicate

An exhaustive run reporting zero failures is evidence about the predicate, not
about the code, until the predicate has been watched to fail.

- **Dump one complete result and read it before writing any predicate against
  it.** A sweep of 65,536 rows reading a field that had been renamed reported
  perfect health, instantly and loudly.
- **Report the distribution across every state, not the count of failures.** A
  guard that swallows everything and a guard that catches nothing both report
  zero. Only the spread separates them.
- **Never call the code under test from the assertion.** Mutating a shared
  helper moves the rule and the check together, and the test passes while the
  bug runs. Write the predicate out independently and assert the lib agrees.

### Can this fixture tell the difference?

Ask it of every guard, and note that it is a QUESTION rather than a conclusion:
the only way to answer it is to mutate the code and watch whether the suite
notices. Reading the fixture cannot answer it, because a fixture that isolates
nothing looks exactly like one that isolates everything.

The failure is not a wrong assertion. It is a correctly-worded assertion whose
fixture cannot vary the thing it is about, so the guard is decorative and green
means nothing. Three of these on 2026-08-06, all the same shape:

- **A trim guard passed with trimming added**, because every fixture was already
  trimmed at the ends. Nothing in the suite could tell a function that trims from
  one that does not.
- **A tidied-quote detector passed with its normalisation removed**, because the
  fixture shared an eight-word run before its first repaired word. The run was
  doing the work; the normalisation was untested — and the version that would
  have shipped scored a CLEANER copy as LESS like the original.
- **An avatar-seed check passed with the seed replaced by a constant**, because
  the two personas compared were of different genders and so landed in different
  buckets anyway. Only the gender varied; the seed was never exercised.

Each assertion was right. Each guard was worthless. The tell is that the mutation
you expect to fail does not — so make the mutation, every time, and hold one
variable at a time when building the fixture: same gender, same padding, same
prefix. If two things differ between your fixtures, you are testing neither.

### Enumerate the legal shapes, not the shapes you happen to have

Production data is a sample, and usually a biased one. Testing against the rows
that exist tests the generator's habits, not the code's contract.

`lib/frameworkAnalysis.ts` permits **2 or 3** steps per phase, so a framework
has 6 to 9 steps across eight legal shapes. All three framework rows in
production are `3+3+3`. Every real framework divides cleanly by three — so the
reshape distribution had a defect (a session labelled with one phase carrying a
step from the next) that **could not surface on any live account**, and would
have waited for the first coach whose framework came back `2+2+3`. Both of the
first-draft fixtures were `3+3+3` and `2+2+2`, and both divided cleanly, so the
mutation that should have failed did not.

The whole production dataset was hiding it. So: derive the legal shapes from
the rule that generates them — the prompt constraint, the CHECK, the enum — and
run all of them. A fixture drawn from live data proves the code works on the
past.

### The file cited as the precedent is the one nobody has read

"Follow the pattern in X" is a claim about X, and it inherits all the authority
of a citation while having had none of the scrutiny. Being named as the example
is what stops anyone opening it.

`spec-member-provisioning.md` told the builder to rate-limit the new resend
endpoint "same posture as `api/auth/send-magic-link.ts`, which is the
precedent." That endpoint had no rate limit at all. It was public, minted a
`magic_link_tokens` row and sent an email per request for any address that was
a member — unbounded row growth and a way to bomb one inbox — and it stayed
that way precisely because it was the thing everyone was told to copy. It was
found by a sweep for the property, not by anyone reading the reference.

So: **open the file you are citing, before you cite it.** And when a review
turns up one instance of a defect, sweep for the class before fixing the
instance — the reported example is rarely the worst one. The same sweep that
found this also found `api/stripe/webhook.ts` accepting a forged
`payment_intent.succeeded` when its secret was empty, which nobody had reported
and which granted paid tiers.

### Assert the thing, not its proxy

- A guard shaped like a container (bucket, host, path prefix) passes until real
  data shares that container. Assert the **specific value** that must be absent.
- A fixture that shares no host, id or shape with production data proves nothing
  about production data.
- A mock without the real table's constraints will pass a design the database
  rejects.
- If every fixture already satisfies a guard, the mutation that guard exists to
  catch is untested. Add the fixture that violates it.

### Stale comments are defects

A comment that was true of the previous design is a lie the next reader will act
on. When behaviour changes, the comment above it changes in the same commit.
Four instances on 2026-08-06: a "needs a decision" note on an answered question,
a `PROPOSAL FOR JAMAUL` block describing work that had shipped, a hardcoded
count above a table of a different size, and a mapping rationale that survived
the mapping it justified.

### Counts and copy come from the data

Never write a literal for something the data already knows: question counts,
served string totals, list lengths, "Question X of 7". Derive it. The only
literals that stay explicit are the ones pinning intended **shape**, and those
belong in one place.

---

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
- **An absent field means UNKNOWN, never zero or empty.** Rows written before a
  field existed do not carry it, and "nothing was recorded" is a different fact
  from "there was nothing to record". `weekly_breakdown[].step_ids` is the live
  case: a breakdown generated before `program/reshape` shipped has no step ids
  because the model wrote prose and nothing captured which steps it meant — it
  does **not** mean the plan covered no steps, and a consumer that renders it as
  "0 steps" or filters those rows out is wrong about every program predating the
  endpoint. Same shape as the six hero aliases, which were confirmed present in
  source and absent on the wire because the stored rows predated the deriver.
  Read absence as "ask the source", backfill, or derive at read time — never as
  a value.
- **Method check before the auth gate**, so a route's shape is answerable
  without a session and a wrong method reads as 405 rather than 401. 104 of 123
  handlers do this; the exceptions are the ones serving GET as well as POST,
  which need the user for the GET branch. It matters beyond tidiness: the
  frontend's route manifest infers from the status, and an auth-first route
  looks like a different kind of route.

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

**A leak assertion starts failing on a legitimate value, and the obvious fix is
to weaken it.** The private thing and the public thing can live in the same
place: `users.avatar_url` is `avatars/avatars/<uid>`, a coach's Brand Identity
headshot is `avatars/brand/<uid>/headshot` — same bucket, same host, same coach
id. Measured against the real production URLs, three plausible phrasings of "the
account photo did not leak" all catch the leak *and* reject the headshot:
`/avatars/`, the coach's uid, `/storage/v1/object/`. Only the account **object
path** discriminates. **Assert the specific value is absent, never the container
it sits in** — and note the direction of the trap: the bucket-shaped guard looks
green until someone uploads a real headshot, and then the pressure is to relax
the guard rather than re-aim it, which is how it stops guarding.
Two second-order lessons, both of which applied here:
- A guard can be correctly phrased and still untested, if the fixtures are far
  enough apart that the wrong phrasing would also pass. These fixtures now share
  the bucket on purpose, and `tests/brandIdentity.test.ts` asserts a healthy page
  **contains** `/avatars/`, the uid, and the storage host — so the degraded
  phrasing fails the suite instead of being quietly accepted.
- Mutate the guard and watch it fail before believing it. Swapping
  `ACCOUNT_OBJECT` to `/avatars/` fails three assertions; without running that,
  "it's value-shaped" was a claim about the code, not a fact about the suite.
Keep the value check and any column-name check separate and labelled: no storage
URL contains the string `avatar_url`, so the key check is blind to a leaked value
and must not be mistaken for the leak guard.

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

**A green gate that proves nothing, because the working tree is not what you
think it is.** The local checkout rewound to an older commit mid-session. All 37
test files ran and passed — but the session's own five test files no longer
existed, so the run was green about code that wasn't there. Nothing in the
output said so: a gate reports on the files it finds, and it cannot report on
files it doesn't.
**The assertion COUNT is the tell, and it is the only one.** 2380 → 2001 with
zero failures is not a quiet success, it is a missing suite. Note the direction
of the trap — the number going *down* while everything passes reads as calm.
Check the total against what you last saw before believing a green run, and if
it moved without a deletion you intended, find out why before merging.
Recovery, in order: `git ls-remote origin` first, because it distinguishes a
local rewind (remote intact, nothing lost) from a real one and takes a second.
Then `git fetch --force origin refs/heads/main:refs/remotes/origin/main` — a
plain fetch will NOT correct an `origin/main` that has rewound backwards.
Related, and the reason this cost as much as it did: **back work up the same way
every time.** Untracked files were safe in a scratchpad copy; the one file
restored with `git checkout <path>` was the one whose changes were destroyed.
`git checkout` on a path is not a backup, and a mixed strategy fails exactly
where it differs.
