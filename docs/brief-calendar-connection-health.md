# Brief — Google Calendar connection health

**Status: WRITTEN, NOT APPLIED.** Nothing here has touched production. No
migration file exists yet, no code has changed, no test has been written. The
three decisions in §7 need answering before any of it is built.

Measured against production on 2026-08-08. Next migration number is **097**
(`supabase/migrations/` ends at `096_bookings_lead_id.sql`, and
`applied_migrations` agrees).

---

## 1. What is wrong

`GET /api/calendar/google/status` reports `connected: true` whenever a row
exists in `calendar_connections`. It never asks Google anything. The row is
written once at consent and updated only by a successful refresh, so the answer
it gives is *"a coach once completed the OAuth flow"* — not *"this calendar
works."*

Those two diverge the moment a refresh token dies, which happens without any
action on our side:

- the coach revokes access in their Google account settings
- the coach changes their Google password (revokes outstanding grants)
- the app is removed from their account, or the grant expires from disuse
- our `CALENDAR_TOKEN_KEY` rotates, so `decryptToken` returns null
- our `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` change

`getValidAccessToken` (`lib/googleCalendar.ts:202`) discovers every one of these
and **returns `null` for all of them, including a network blip**, logging one
line and moving on. Nothing is written down. The next caller re-discovers it, the
next one after that re-discovers it again, and the coach's settings page keeps
saying *Connected — jamaul@…* the entire time.

### The consequence is not cosmetic

`lib/funnelAvailability.ts:21` calls `getValidAccessToken` and, when it gets
null, **degrades to bookings-only**:

```ts
const conn = await getValidAccessToken(ownerUserId)
if (conn) { busy.push(...(await fetchFreeBusy(...))) }
// …then the owner's own active MTM bookings
return { slots: subtractBusy(grid, busy), connected: !!conn }
```

The grid stops subtracting Google's busy blocks. Every meeting the coach has
that MTM did not create becomes bookable. A lead picks one, and
`api/calendar/book.ts` — correctly, by the comment at line 122, *"A FUNNEL
BOOKING IS HOSTED BY ITS COACH, with or without Google"* — books it anyway,
without a calendar event and without a Meet link.

So the shape is: **a lead books a slot the coach is already busy in, the coach
gets no calendar entry, and both sides believe it worked.** The coach finds out
when two people arrive at once.

That behaviour is deliberate and should stay — refusing to book because Google
is unreachable would be worse. What is missing is that nobody is told.

### What production looks like today

One connection, healthy:

| | |
|---|---|
| connections | 1 (`provider = 'google'`) |
| access + refresh token | both present |
| `connected_at` | 2026-08-08 03:34 |
| `updated_at` | 2026-08-08 04:48 |
| `updated_at > connected_at` | **true** — a refresh has succeeded since consent |
| scope | `calendar.readonly calendar.events` |

`expires_at` is in the past, which is normal: the access token is short-lived and
the next call refreshes it. Nothing here is broken. **That is the point** — there
is currently no way to tell this row apart from a dead one, because the columns
that would tell them apart do not exist.

---

## 2. The shape

Two columns on `calendar_connections`:

| column | type | meaning |
|---|---|---|
| `invalid_since` | `timestamptz` null | when we FIRST observed the connection to be unusable, and still do |
| `invalid_reason` | `text` null | which of the three failures it was |

**A timestamp, not a boolean.** Per the convention in CLAUDE.md, derive at read
time from raw signals rather than storing computed state. `invalid_since`
answers *how long* as well as *whether*, which is what lets a later rule ("only
email after it has survived N hours") be added without a second column and
without restamping history. A boolean throws that away on the first write.

**Null means healthy**, and no backfill runs. Existing rows are presumed working
because we have no evidence otherwise, and marking a live coach broken on no
evidence is worse than the gap this closes.

### `invalid_reason`, and the fourth value that must not exist

| value | what happened | who fixes it |
|---|---|---|
| `invalid_grant` | Google rejected the refresh token — revoked, expired, password changed | the coach, by reconnecting |
| `invalid_client` | Google rejected **our** credentials | us, by fixing the env |
| `decrypt_failed` | `decryptToken` returned null — key rotated or ciphertext corrupt | us, then the coach reconnects |

There is deliberately **no `unavailable`**. A 500 from Google, a DNS failure or a
15-second timeout is not evidence about the connection, and recording it would
make the column mean "the last call didn't work", which is not worth storing and
is actively harmful — one blip and a healthy coach gets told to reconnect. A
transient failure must leave both columns exactly as they were.

Distinguishing `invalid_client` matters more than it looks. It is not the coach's
fault and **reconnecting cannot fix it** — the consent flow uses the same broken
credentials. Telling a coach to reconnect in that state sends them round a loop
that cannot terminate, which is how a support ticket becomes an afternoon.

### The code cannot currently tell them apart

`tokenRequest` (`lib/googleCalendar.ts:96`) flattens the discrimination into a
string:

```ts
if (!res.ok) throw new Error(`google token ${res.status}: ${data.error || ''} …`)
```

and `getValidAccessToken` catches everything, including the fetch rejection, into
one `return null`. **The failure needs to arrive typed, not be regex'd back out
of a message.** A `GoogleTokenError` carrying `{ code: string | null, status:
number | null }` — where `code` is Google's own `error` field and is `null` for a
transport failure — is enough, and the mapping to `invalid_reason` then reads as
a `switch` rather than as string matching. This is the part most likely to be
skipped, and skipping it is what produces a column that says `invalid_grant`
when Google was merely down.

### Migration 097

```sql
alter table public.calendar_connections
  add column if not exists invalid_since timestamptz,
  add column if not exists invalid_reason text;

-- text + CHECK rather than a Postgres enum: widening a CHECK is one migration,
-- widening an enum type is not.
alter table public.calendar_connections
  add constraint calendar_connections_invalid_reason_check
  check (invalid_reason is null
         or invalid_reason in ('invalid_grant', 'invalid_client', 'decrypt_failed'));

-- The pair moves together or not at all. A reason with no time cannot be aged;
-- a time with no reason cannot be acted on. Either alone is a bug that the
-- database can refuse.
alter table public.calendar_connections
  add constraint calendar_connections_invalid_pair_check
  check ((invalid_since is null) = (invalid_reason is null));
```

Validate inside `begin; … rollback;` against production before applying, and say
what is about to be applied. Two `add column` on a one-row table is not a risky
migration, but the pair constraint is the interesting part and it should be
watched to reject a half-set row in the rollback transaction — otherwise it is a
constraint nobody has seen work.

---

## 3. What `status` returns, and the three states

### Today

```json
{ "connected": true, "calendar_email": "…", "connected_at": "…" }
{ "connected": false }
```

### Proposed

```json
{ "connected": false, "state": "not_connected" }

{ "connected": true, "state": "connected",
  "calendar_email": "…", "connected_at": "…" }

{ "connected": true, "state": "needs_reconnect",
  "calendar_email": "…", "connected_at": "…", "invalid_since": "…" }

{ "connected": true, "state": "app_misconfigured",
  "calendar_email": "…", "connected_at": "…", "invalid_since": "…" }
```

**One field with four values, derived at read time**, rather than a second
boolean the caller has to combine with the first. Two booleans is four states of
which one (`connected: false, invalid: true`) is nonsense, and every caller has
to independently work out that it is nonsense.

`state` maps from the stored reason:

| `invalid_reason` | `state` | because |
|---|---|---|
| null | `connected` | |
| `invalid_grant` | `needs_reconnect` | the coach reconnecting fixes it |
| `decrypt_failed` | `needs_reconnect` | ours to cause, but reconnecting is still the fix |
| `invalid_client` | `app_misconfigured` | reconnecting cannot fix it — do not ask |

Three reasons collapse to two states on purpose: **`state` is what the coach
should do, `reason` is why it happened.** Keep both — the reason belongs in the
log and in a support conversation, not on a coach's screen.

### `connected` keeps its current meaning

`connected: true` continues to mean *a row exists*. It does **not** flip to
false when the connection is broken.

Two reasons. First, flipping it discards the context that makes the message
useful — *"we were connected to jamaul@…, and it stopped working on the 3rd"* is
a different message from *"connect your calendar"*, and the second one is what a
coach sees today after they already connected it. Second, it would be wrong for
`app_misconfigured`, where there is nothing for the coach to do.

**Say the consequence plainly: this change fixes nothing on its own.** A
frontend keying on `connected` alone will show the same green tick it shows
today for a dead connection. The endpoint stops lying only once something reads
`state`. That is a frontend change in `client-atm-frontend` — another session's
repo — and it should be agreed there before this ships, or we will have added a
field nobody reads and believed the problem solved.

---

## 4. Can anything but `getValidAccessToken` discover the failure?

**No.** Every discoverer today routes through it, and all of them are lazy —
they need someone else's traffic before the truth surfaces:

| path | who triggers it |
|---|---|
| `lib/funnelAvailability.ts:21` | a **lead** loading a booking page |
| `api/calendar/book.ts:114,117` | a **lead** booking |
| `createCalendarEvent` (`:260`) | after a booking |
| `updateCalendarEvent` (`:331`) | a reschedule |
| `deleteCalendarEvent` (`:304`) | a cancel / reservation release |

And the one endpoint a coach hits on purpose — `GET /api/calendar/google/status`
— **does not call it at all.** It selects two columns from the row and returns.
That single fact is why a coach can sit on a broken calendar indefinitely: the
page built to tell them about the connection is the only page that never checks
it.

### The cheapest real fix: make `status` a discoverer

Have `status` call `getValidAccessToken`. It is authed, it is deliberate, it is
one token round-trip (~200–400ms), and it makes detection and clearing the same
act — a coach who opens the page after fixing things in Google sees it go green
because the same call that would have recorded the failure recorded the success.

Two things to be honest about:

- **It makes a GET write.** `getValidAccessToken` already persists rotated
  refresh tokens, so this is not a new property of the system, but it is new for
  this endpoint and it should be written down rather than discovered.
- **It must never fail the response.** If the refresh errors transiently, status
  reports the last known stored state. A settings page that 500s because Google
  was slow is a worse page than one that is briefly out of date.

### What proactive detection would take

Nothing above finds the failure before a lead does. Only a scheduled sweep can —
a cron that walks `calendar_connections` and calls `getValidAccessToken` on each,
roughly one token request per coach per day. It is a small job and the recording
logic is the same logic.

**Not worth building at one connection.** It is worth building at the point where
a broken calendar could go unnoticed for a day, which is when there are enough
coaches that Jamaul is not personally aware of each one. Revisit then; the
column this brief adds is what such a cron would write to, so nothing is wasted
by deferring it.

---

## 5. Should a coach be told?

**Yes — that is the entire point.** A silently broken calendar produces double
bookings, and the coach is the only person who can fix it. But there are three
questions to settle before building anything, and the brief is deliberately
stopping at describing them.

### What it would take

**Channel.** In-app on the settings page is free once `status` carries `state` —
the page already exists and already calls the endpoint. Email is the one that
reaches a coach who is not looking, which is precisely the case that matters: a
coach whose calendar broke is by definition not watching the calendar settings
page. Resend, published template by alias (`mtm-*`), never inline HTML, per the
convention. Wrapped in try/catch, logged, never thrown — a mail failure must not
roll back the write that recorded the failure.

**Trigger.** Not "whenever `getValidAccessToken` fails" — one lead refreshing a
booking page would send ten emails. Trigger on the **transition**: the write that
moves `invalid_since` from null to a value. That is naturally once, because
every subsequent failure finds it already set. This is the second reason the
column is a timestamp rather than a flag being re-set: the transition is
observable as *"was null, now is not"*.

**The cost of being wrong.** A false *"your calendar disconnected"* over a Google
blip is worse than silence — the coach reconnects for nothing and learns to
ignore the next one, including the real next one. Two defences: never record
`unavailable` (§2), and consider requiring the condition to survive a second,
later observation before emailing. Recording `invalid_since` immediately is
cheap and reversible; sending an email is neither. Note the tension honestly:
without a cron, "a second later observation" means waiting for the next organic
failure, which may be the lead double-booking. That trade is a decision, not a
detail.

**Copy.** Name the calendar address, say what stopped working and roughly when,
and link straight into the reconnect flow — `/api/calendar/google/connect?mode=url`
is already there for a Bearer-only frontend. Do not say "reconnect" for
`app_misconfigured`.

### Recommendation

Ship the in-app state now (it is nearly free, and the frontend needs the field
regardless). Build the transition-write now, because the email hangs off it and
retrofitting a transition later means restamping. **Defer the email** until the
transition-write is real and there is more than one coach. Do not build either
without §7 answered.

---

## 6. The two properties that must hold

Both are about the column being *cleared*, which is the half that silently rots:
a flag that sets correctly and never clears turns into a permanent red badge on
a working calendar, and the fix for that is always to stop trusting the badge.

### Property 1 — a successful refresh clears it

> After `getValidAccessToken` completes a refresh successfully, `invalid_since`
> and `invalid_reason` are null.

**In the same update, not a second write.** `getValidAccessToken` already builds
one update object (`lib/googleCalendar.ts:227`); the two nulls go in it. Two
writes can disagree, and the window between them is exactly when a concurrent
read gets a broken answer about a working connection.

*Test:* a stored connection with `invalid_since` set and an expired access
token, a stubbed token endpoint that returns a fresh access token → assert the
persisted payload carries `invalid_since: null` and `invalid_reason: null`.
*Mutation:* delete the two keys from the update object; the test must go red. If
it does not, the fixture is not starting from an invalid row.

### Property 2 — reconnecting clears it

> After `saveGoogleConnection` completes, `invalid_since` and `invalid_reason`
> are null.

**This one will not hold by accident, and that is why it is written down.**
`saveGoogleConnection` (`:159`) upserts with `onConflict: 'user_id,provider'`,
and PostgREST's merge updates **only the columns present in the payload**. Every
column it does not name keeps its old value. So a coach who reconnects
successfully would keep `invalid_since` set from the previous failure, and their
freshly-working calendar would report `needs_reconnect` forever. The row must
carry `invalid_since: null, invalid_reason: null` explicitly.

*Test:* seed an invalid row, call `saveGoogleConnection`, assert the upsert
payload carries both as null. *Mutation:* drop them from `row`; red.

### A third, unrequested but load-bearing

> A transient failure records nothing.

Without it the column is not trustworthy and neither property above matters,
because the field will be set most of the time for reasons that have nothing to
do with the connection.

*Test:* two fixtures that differ **only** in the failure kind — one where the
token endpoint answers `400 {"error":"invalid_grant"}` (records) and one where
the fetch rejects or answers `503` (records nothing). *Can this fixture tell the
difference?* Only if the failure kind is the sole variable. If both fixtures are
`invalid_grant`, the "records nothing" assertion is decorative and green means
nothing — so hold the connection row, the clock and the stored tokens identical
across the two, and vary one thing.

### One writer

The recording belongs in `getValidAccessToken` and nowhere else. Five call sites
each deciding for themselves what a failure means is how two of them end up
disagreeing about `invalid_client` within a month — the same shape as the two
`bookings` scoping rules before `lib/coachBookings.ts`, and the seven copies of
`API_URL` before `lib/appUrls.ts`.

---

## 7. Decisions needed before this is built

1. **Does `status` become a discoverer?** It means a GET that calls Google and
   may write. Recommend **yes** — it is the only way a coach's own settings page
   can ever be right, and it is where the coach already is.

2. **Does `connected` keep meaning "a row exists"?** Recommend **yes**, with a
   new `state` field beside it. The alternative flips `connected` to false on a
   broken connection, which loses the context and is wrong for
   `app_misconfigured`. Either way this needs agreeing with
   `client-atm-frontend` before it ships, or we add a field nobody reads.

3. **Email now or later?** Recommend **later** — build the transition-write now
   so the email is cheap to add, and decide the false-positive rule (§5) when
   there is more than one coach to get it wrong for.

Nothing is applied. Answer these and I will build it.
