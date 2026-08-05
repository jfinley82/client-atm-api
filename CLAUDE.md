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
