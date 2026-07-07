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
conversation again and the new `<data>` overwrites the old profile. (There is
no reset endpoint — to start from a truly blank slate, use a fresh test user.)

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
