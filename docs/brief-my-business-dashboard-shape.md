# Shape report — the My Business dashboard payload

**Status: REPORT ONLY. Nothing built.** Awaiting sign-off on §1 before code.

Committed as a file rather than sent as a message, because this is the second
time it has been sent and the fourth document to go missing between us today. A
file on the branch cannot be lost in transit.

Revised to fold in the answers of 2026-08-08 on `never contacted` (§4) and on
book-rate scoping (§5), so this is one current document rather than a report plus
a correction.

---

## 0. The scoping, confirmed rather than re-proven

`loadOwnedActiveBookings` is used by **all four** booking arms —
`api/calendar/index.ts`, `api/contacts/index.ts`, `api/contacts/[leadId].ts`,
`api/funnels/portfolio.ts`. Funnels are `.eq('user_id', userId)` everywhere.
`client_programs` owns itself through `user_id`, and its bookings resolve by
`program_id`, which is a different question and correctly not routed through the
booking helper.

**No arm bypasses the shared helper.** Nothing to fix. The dashboard imports
these; it does not restate them.

---

## 1. One endpoint — and the payload argument is the *second* reason

Tested rather than assumed. The response-size case is real but it is not what
decides it.

### The first-order cost is duplicated scans

A composed dashboard, calling four endpoints, loads:

| table | scanned by | times |
|---|---|---|
| `funnel_leads` | contacts, calendar, portfolio | **3×** |
| `bookings` | contacts, calendar, portfolio — 2 queries each via the helper | **3× = 6 queries** |
| `funnel_events` | portfolio | 1×, **unbounded** |

That last one is the sharpest. `api/funnels/portfolio.ts:115` pulls **every
`landing_view` row ever recorded** to count visitors:

```ts
supabase.from('funnel_events').select('funnel_id').in('funnel_id', funnelIds).eq('event_type', 'landing_view')
```

87 rows today, and uncapped. At 50,000 views that is 50,000 rows fetched to
render one number, on every dashboard load. A dedicated endpoint replaces it with
`count: 'exact', head: true` per funnel — N small queries where N is the coach's
funnel count, realistically 1–10.

### The response-size case, for completeness

At a modest 500-lead coach: `/api/contacts` returns **all 500 contacts**,
`/api/calendar` up to 600 rows across three queues, `/api/funnels/portfolio`
per-funnel analytics plus 50 rows. The dashboard renders **nine numbers and about
twelve rows**. Roughly 40× over-fetch.

### Net

**~9 queries → ~5, one unbounded scan removed, one round trip instead of four.**

Dedicated endpoint. I would hold that view even if the response sizes were
identical, because the unbounded `funnel_events` scan is a growth cliff and the
triple lead/booking scan is pure duplication.

---

## 2. Cost of the eight attention items

Seven of eight are **free** — they ride on scans the endpoint already needs
(leads, bookings, funnels, programmes):

- past calls with no outcome
- approved leads who never booked
- drafts not yet sent
- calls booked this week
- funnels still in draft
- open session requests
- leads with no activity (§4)

**One is not: `stalled`.** It needs every `client_program_items` row across every
programme — roughly `programmes × 20`. Free today (0 programmes), fine at 50
programmes (~1,000 rows), and it is the only item requiring a query nothing else
needs.

It earns its place — a stalled client is the highest-value thing on the strip —
but **it is the one to drop first** if the dashboard ever needs trimming, and
that is worth knowing now rather than finding in a slow load.

---

## 3. Shape and the list rules

Counts are over **everything**; lists are truncated. Every list gets an explicit,
meaningful order:

| list | size | order |
|---|---|---|
| Clients | 5 | open request, then stalled, then soonest due item; drafts last |
| Funnels | all | live before draft, then leads descending — a coach has 1–10, truncating is theatre |
| Leads needing attention | 5 | oldest first, since age is the reason they are listed |
| Coming up | 5 | ascending by `start_time` |
| Open session requests | 5 | oldest first |

**Zero is first-class.** Every count `0`, every list `[]`, and *"not applicable"*
distinguished from *"nothing yet"*: a coach with no confirmed `program`
saved_output gets `method: null` — they have not built one — which is a different
state from a coach whose programmes are all complete. `booking_slug` is nullable
on `funnel_business_settings`, so the booking link renders as absent rather than
as a broken URL.

The contract is **generated** into `docs/served-contract.md` by extending
`scripts/served-contract.mjs` over a pure serializer, exactly as the
client-programs shapes are.

---

## 4. `never contacted` — replaced with `no_activity`

**Nothing in the schema records a coach contacting a lead.** `funnel_leads` has
no `contacted_at`; `optin_notified_at` and `application_notified_at` are *us*
notifying the *coach*; `funnel_lead_notes` exists and holds **0 rows**.

Per the 2026-08-08 answer, the tile becomes **"No activity"** — a claim about the
record, not about the coach — and is true when **all four** hold:

1. `status` is still `lead`, and
2. no note exists against them, and
3. no booking exists for them, and
4. no application was submitted

**Nurture emails are deliberately excluded from the test.** They go out
automatically, so counting them as activity would empty the queue without anyone
having done anything. That sentence goes in the code, because it is the
carve-out someone will otherwise "fix".

No contact tracking is being added. That is a feature and a decision for Jamaul,
not something to build so a label becomes true.

---

## 5. Book rate, and the reconciliation gap — with a correction to the figure

**Settled:** numbers about the **coach** include coach-page bookings; numbers
about a **funnel** do not. Book rate is bookings whose `funnel_id` is that funnel
over leads whose `funnel_id` is that funnel, and nothing else — a coach-page
booking has no funnel, and attributing it to one would invent a source. This is
the line `api/funnels/portfolio.ts` already sits on.

### The figure in the brief was wrong, and the real one is worse

The brief said the gap is *"8 of 11 rows in production"*. That counts rows
belonging to **no coach at all**. Measured scoped the way
`loadOwnedActiveBookings` scopes:

| | |
|---|---|
| bookings in the table | 12 |
| **owned by the real coach** (either arm) | **2** |
| of those, from a funnel | **0** |
| of those, no funnel — the remainder | **2** |
| owned by nobody (`coach_user_id` null **and** `funnel_id` null) — MTM's own `/book` calls | 7 |
| from funnels owned by the *other* account | 3 |

So for the one real coach today, **every call he owns belongs to no funnel.** The
per-funnel column would read 0 while the headline read 2. Not a marginal
discrepancy — a total one.

### Yes, the payload can carry the remainder

`loadOwnedActiveBookings` already returns both arms, so a booking with
`funnel_id === null` **is** the remainder — no extra query, no new scoping rule.
The payload carries it explicitly, so the frontend shows a row rather than
leaving a hole that reads as a bug:

```
calls_total          all calls this coach owns          (coach-scoped)
calls_from_funnels   sum of the per-funnel counts       (funnel-scoped)
calls_no_funnel      the remainder — booked directly    (coach-scoped)
```

with `calls_total === calls_from_funnels + calls_no_funnel` as an invariant the
test asserts, so the three can never drift into a set that does not add up.

Naming them so the reader can tell which question each answers is the fix —
reconciling by changing either number would be the wrong one.

---

## 6. Acceptance, as I will build against it

Restating with §5's correction folded in, so there is one version:

1. A coach with nothing gets a well-formed response, every count `0`, every list
   `[]`. Driven against a real account with no data.
2. Counts match reality across the whole set, not the truncated list — asserted
   against a directly-queried total.
3. Coach A sees nothing of coach B's, in every array. Two real ids.
4. **Coach-scoped** booking numbers include coach-page bookings; **funnel-scoped**
   numbers do not; and `calls_total = calls_from_funnels + calls_no_funnel`.
5. Ownership resolves through the existing shared helpers — assert no new scoping
   predicate was introduced.
6. The contract is generated, not transcribed.
7. `npm run gate` green on the exit code, pass count stated.
