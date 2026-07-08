# Scripted conversation test runner

Plays a pre-written sequence of answers against the **live deployed** MTM chat
API, exactly the way the real frontend does, so you can exercise a full tool
conversation end-to-end in under a minute instead of typing answers by hand.

It hits the real endpoint (`POST /api/tools/{tool}`) with a real Bearer token
and real cumulative `session_history` — nothing is mocked or bypassed, so it
runs the actual production code path. **It upserts the test user's
`saved_outputs` row** just like a real session, so run it with a test account.

## Run it

```bash
CATM_TOKEN='<real-session-jwt>' node scripts/run-conversation.mjs scripts/conversations/transformation.sample.json
```

That's the whole thing. Swap in `audience.sample.json` or `matcher.sample.json`
for the other tools.

### Getting the token
`CATM_TOKEN` is the same JWT the browser sends as `Authorization: Bearer …`.
Grab it from the test account's session — in the browser devtools, Network tab,
look at any `/api/tools/*` request's `Authorization` header (or your app's
stored session token). It's a long-lived token (1-year expiry).

### Options
| flag / env | default | meaning |
|---|---|---|
| `CATM_TOKEN` / `--token` | — (required) | session JWT for the test account |
| `API_BASE` / `--base` | `https://client-atm-api-workwithjamaul-4008s-projects.vercel.app` | API origin to hit |
| `--tool` | from spec | override the tool_type |
| `--max-turns` | `30` | safety cap on turns |
| `--verbose` | off | print full `structured_data` every turn |
| `--swap` | off | Transform/Matcher only — exercise the re-select path at each decision point instead of the default pick (see below) |

Examples:
```bash
# point at a preview deployment instead of production
CATM_TOKEN=… node scripts/run-conversation.mjs scripts/conversations/audience.sample.json --base https://client-atm-<hash>.vercel.app

# see the full structured_data grow turn by turn
CATM_TOKEN=… node scripts/run-conversation.mjs scripts/conversations/matcher.sample.json --verbose
```

## What it prints

**Per turn:** the answer sent, the AI's message, whether `structured_data`
changed (which fields were added/changed), and the **`completed`** flag. It
**stops automatically** the moment the API returns `completed: true`.

**At the end:**
- how many turns it took and wall-clock time
- whether every `expectedField` populated (empty/missing ones are listed)
- an anomaly scan: empty fields, duplicate or templated-looking array entries
  (the old "objections" bug signature), and narration leaks (schema field names
  or raw `<data>`/JSON appearing in a visible message)
- the final full `structured_data`
- a one-line VERDICT

Exit code is `0` on a clean run, `1` if anything looked off — so you can wire it
into CI later if you want.

## Transform pipeline (transformation only)

Once a `transformation` conversation reaches a genuine `completed: true`, the
runner automatically continues through the rest of Transform end to end — no
extra flag needed:

1. `POST /api/tools/transformation/analyze` — prints the 3 candidates
   (`id`/`problem`/`whySelected`) plus `zoneOfImpact`/`intersection`/`uniquelyEquipped`.
2. `POST /api/tools/transformation/select` — **always required**: unlike
   framework (below), `transformation/analyze` has no model-suggested default
   (`selected_id` is always `null`), so the runner picks the first candidate
   (`t1`) by default. `--swap` re-selects a *different* candidate afterward,
   which also exercises the real re-select code path (`confirmed` resets to
   `false` on re-selection).
3. `POST /api/tools/transformation/confirm` — the chosen candidate and shared
   fields, passed through unedited.
4. `POST /api/tools/transformation/framework/analyze` — prints the 3
   `name_options` and the 3 `phases` (name + step count each).
5. `POST /api/tools/transformation/framework/select` — **skipped by default**:
   framework/analyze *does* return a real model-chosen `selected_name_id`
   (already resolved into `frameworkName`/`frameworkTagline`), so the default
   run accepts it as-is. `--swap` selects a different name option instead.
6. `POST /api/tools/transformation/framework/confirm` — the chosen framework,
   passed through unedited.

**Expected-state checks** (hard failures — the run exits immediately with a
`STAGE FAILED: <exact stage>` message naming which stage broke, on the first
violation): exactly 3 candidates, exactly 3 name options, exactly 3 phases,
each phase has 2-3 steps, and `frameworkName`/`frameworkTagline`/
`descriptiveCopy`/`useCases`/`audienceLanguage` are all populated after
`framework/confirm`.

**Anomaly scan** (soft — collected and reported, flips the final VERDICT and
exit code but doesn't stop the pipeline): empty nested fields anywhere in the
candidates/name options/phases/steps, and duplicate/near-duplicate text across
the 3 candidates' `problem`s, the 3 name options' `name`s, or the 3 phases'
`name`s. Narration-leak scanning does not apply here (there's no conversational
`message` channel in this pipeline, only direct JSON responses).

```bash
# full Transform pipeline, accepting the model's own picks
CATM_TOKEN=… node scripts/run-conversation.mjs scripts/conversations/transformation.sample.json

# same, but exercise the re-select/swap path at both decision points
CATM_TOKEN=… node scripts/run-conversation.mjs scripts/conversations/transformation.sample.json --swap
```

## Matcher pipeline (matcher only)

Once a `matcher` conversation (the short existing-offer intake) reaches a
genuine `completed: true`, the runner automatically continues through the
rest of Matcher end to end — no extra flag needed:

1. `POST /api/matcher/analyze` — requires `audience`, `transformation`, and
   the matcher intake to **all already be complete** for this user (it 400s
   with `audience_incomplete`/`transformation_incomplete` otherwise — a real
   precondition, not a runner bug). Prints the full `top_10` list
   (`problem`/`reasoning`/`match_strength`/`match_factors` scores each,
   recommended ones marked with `★`, always in server-guaranteed
   `match_strength`-descending order regardless of model emission order), the
   3 `recommended_ids`, `why_recommended`, and `insights`.
2. `POST /api/matcher/selection` — **skipped by default**: unlike
   `transformation/select` (where `selected_id` is always `null` out of
   `/analyze`), `matcher/analyze` already sets `selected_ids` to its own
   `recommended_ids` and generates `suggested_offers` for them in the same
   call — so the default run accepts that as-is, the same way
   `framework/select` gets skipped. `--swap` calls it with a genuinely
   different combination of 3 ids drawn from the remaining 7.
3. `POST /api/matcher/finalize` — submits the 3 selected items' generated
   content unedited. Note: the request body here is the bare array of 3
   cards, not wrapped in an object (unlike every other pipeline endpoint).
   `card_name` is not produced anywhere in the generation pipeline
   (`Top10Problem` only has `id`/`problem`/`reasoning`, and
   `suggested_offer.name` is `null` whenever the coach already has an
   existing offer) — Vibe presumably lets the member type/edit this, so the
   runner synthesizes a `card_name` from the problem text as a test-only
   stand-in. Prints the resulting `problem_solution_cards` rows
   (`card_name`, `validated`).

**Expected-state checks** (hard failures — exits immediately with
`STAGE FAILED: <exact stage>`): exactly 10 `top_10` entries, exactly 3
`recommended_ids`, every `top_10` entry carries `match_factors` and a numeric
`match_strength`, exactly 3 finalized cards all with `validated: true`,
non-empty `card_name`/`problem_text`/`reasoning`/`suggested_offer`, and a
non-empty `suggested_offer.angle_note` (the type contract says this field is
always populated).

**Anomaly scan** (soft — collected and reported, flips the final VERDICT and
exit code but doesn't stop the pipeline): empty nested fields in `top_10`
entries, duplicate/near-duplicate text across the 10 `top_10` problems or the
3 finalized cards' `problem_text`/`angle_note`, a **clustering check** on
`match_strength` (flags if the standard deviation across the 10 entries is
below `0.5` — i.e. scores converged instead of genuinely differentiating the
problems), a **templating check** on each of the 4 `match_factors`'
`reasoning` sentences (flags duplicate text across entries, per factor), and
— only when the intake said there was **no** existing offer — empty
`suggested_offer.name`/`format`/`price_point` (these are contractually
allowed to be `null` when the
coach already has an offer, so they're not flagged in that case). Narration
leaks are covered by the intake conversation's own per-turn scan above (there
is no separate conversational channel in the pipeline stages themselves).

```bash
# full Matcher pipeline, accepting the model's own recommended_ids
CATM_TOKEN=… node scripts/run-conversation.mjs scripts/conversations/matcher.sample.json

# same, but exercise the re-select/swap path
CATM_TOKEN=… node scripts/run-conversation.mjs scripts/conversations/matcher.sample.json --swap
```

For `audience` runs, none of this applies — the runner stops at the
conversation summary exactly as before.

## Spec file format

```jsonc
{
  "tool": "transformation",            // audience | transformation | matcher
  "answers": ["...", "..."],           // your pre-written answers, in order
  "expectedFields": ["before_state"],  // optional: raw <data> fields that must be populated at the end
  "fillerAnswer": "..."                // optional: sent if answers run out before completed:true
}
```

The runner sends your `answers` in order regardless of the exact question asked
(just like a person reading their prepared answers). If the conversation needs
more turns than you supplied and hasn't completed, it sends `fillerAnswer` to
nudge toward completion and flags in the summary that scripted answers ran out.

Drop your own transcripts in as new `*.json` files here and point the runner at
them.

## Re-running against a user who already completed a tool

Completion is stored per `(user, tool_type)` and is **monotonic** — once a tool
is finished, the server carries `completed: true` forward. So if the test user
already completed, say, `transformation`, the very first (data-less) turn of a
new run comes back `completed: true` before any new data exists. The runner
handles this: it only stops when `completed: true` arrives **together with
`structured_data` produced during this run**, and prints a `(note: … inherited
from a prior completed session …)` line while it waits for the conversation to
generate its own data. Net effect: re-runs work; they just play the whole
conversation again and the new `<data>` overwrites the old profile. For a truly
blank slate instead, call `DELETE /api/tools/{tool}` first (the same reset
"Restart Chat" uses) — see the endpoint's own comments for exactly which rows
it clears per tool.

## Notes on how it mimics the frontend
- **Auth:** `Authorization: Bearer <token>` (falls back to cookie server-side,
  but this runner uses the header, same as the cross-domain frontend).
- **Body:** `{ message, session_history, current_step }` POSTed to
  `/api/tools/{tool}` — the path alias injects `tool_type`, exactly as in prod.
- **session_history:** rebuilt cumulatively as `[{role, content}, …]`, appending
  the user answer and the AI reply after each turn.
- **current_step:** sent as the 1-based turn number. Note the server's real
  completion signal is `hasTerminalFields`-driven (see `api/tools/chat.ts`), so
  completion does not actually depend on `current_step`; the runner stops on the
  `completed` field, which is the signal the frontend should also use.

---

# Toolkits test script (`run-toolkits.mjs`)

Exercises the 4 supplementary Toolkits — High Ticket Offer Creator (`program`),
Content Creator (`content`), Micro-Training Slide Creator (`slides`), AI Lead
Qualifier (`qualifier`) — against the **live deployed** API. Unlike
`run-conversation.mjs`, these 4 tools have no conversational turn loop of
their own: each is a direct one-shot POST against an **already fully-set-up
account** (audience completed, transformation confirmed, framework confirmed,
core_offers confirmed, 3 validated blueprint cards). That's why this is a
separate sibling script rather than a mode bolted onto the turn-based runner.

## Run it

```bash
CATM_TOKEN='<real-session-jwt>' node scripts/run-toolkits.mjs --card-id <validated-blueprint-id>
```

| flag / env | default | meaning |
|---|---|---|
| `CATM_TOKEN` / `--token` | — (required) | session JWT for the test account |
| `API_BASE` / `--base` | production URL | API origin to hit |
| `--card-id` | none | a real, validated `problem_solution_cards.id` for this account — required for the `slides`/`qualifier` stages; those two are skipped with a clear note if omitted |
| `--platform` | `chatgpt` | passed to `qualifier` (`chatgpt` or `claude`) |
| `--verbose` | off | print full post/slide/system_prompt content |

### Getting a `card_id`

There is currently **no live endpoint that lists** a user's validated
`problem_solution_cards` ids — `/api/cards` (which used to) was deprecated
to `410 Gone` earlier tonight, and the only remaining reads of that table
(`api/dashboard/mtm-profile.ts`, `api/generate/index.ts`'s join) return
`card_name`, not `id`. The real id has to come from where the frontend would
already have it cached: the response of `POST /api/matcher/finalize` returns
the full inserted rows, including `id`. Grab one from there (or query
`problem_solution_cards` directly), and pass it via `--card-id`.

## What it runs

1. `POST /api/toolkits/program/analyze` — no body required
2. `POST /api/toolkits/content/analyze` — run **twice**: once with no body
   (default/skipped intake) and once with an explicit
   `{ platform: 'LinkedIn', tone: 'professional' }`, to exercise both the
   default-fallback path and the explicit-intake path
3. `POST /api/toolkits/slides/analyze` — `{ card_id }` (skipped without `--card-id`)
4. `POST /api/toolkits/qualifier/analyze` — `{ card_id, platform }` (skipped without `--card-id`)

**Hard checks** (exit immediately with `STAGE FAILED: <exact stage>`):
`program`'s `weekly_breakdown.length === total_weeks` and `deliverables`
count (4-6); `content`'s exactly 15 posts (3 per category × 5 categories, in
order) and exactly 5 emails; `slides`'s slide count (10-12) and sequential
`slide_number`s; `qualifier`'s `coach_name`/`system_prompt`/
`deployment_instructions` all non-empty. A `502 generation_truncated`
response is also a hard failure — that means max_tokens was hit for real,
not just close to it (see below).

**Soft anomaly scan** (collected and reported, flips the VERDICT and exit
code but doesn't stop the run): empty fields anywhere in the response,
duplicate/templated text across `program.weekly_breakdown`/`deliverables`,
`content.posts`/`.emails`, or `slides[].title`/`.speaker_notes`, and a
**max_tokens proximity check** — see below. Narration-leak scanning does not
apply (none of these 4 tools have a conversational message channel, only
direct JSON responses).

## max_tokens proximity check

Each tool's real `max_tokens` ceiling is mirrored in this script from source
(`lib/programAnalysis.ts` 4000, `lib/contentAnalysis.ts` 8000,
`lib/slidesAnalysis.ts` 6000, `lib/qualifierAnalysis.ts` 3000 — update here
too if those change). None of these endpoints currently surface Anthropic's
own `usage.output_tokens` over HTTP, so the script estimates it from the
stringified response length (~4 characters per token for English text) —
an early-warning heuristic, not a precise reading. If a response is
already using **75% or more** of its ceiling, that's flagged as a warning:
the same failure class as Matcher's earlier truncation bug (a schema grew,
`max_tokens` didn't, and a real account eventually pushed it over into a
generic 500). Catching "already close" before a live account pushes it over
is the point.

## Verified against a mock server

Before relying on live production access, this script was verified against
a local mock server implementing the 4 real endpoint contracts, covering:
the clean default path, both `content` intake variants, induced malformed
counts (`weekly_breakdown` mismatch, wrong post count), induced duplicate/
templated content across all 4 tools' array fields, a response near its
`max_tokens` ceiling (correctly flagged as a soft warning), a genuine
`502 generation_truncated` response (correctly a hard failure, distinguished
from the soft "close to ceiling" warning), and running with `--card-id`
omitted (slides/qualifier skip gracefully rather than erroring).
