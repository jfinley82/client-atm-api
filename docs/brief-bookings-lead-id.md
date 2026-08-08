# Brief — `bookings.lead_id` (rev 2)

**Status: WRITTEN, NOT APPLIED.** Nothing here has touched production. No
migration file exists yet. Rev 2 applies the three answers from 2026-08-08; the
questions that were open in rev 1 are now decisions and are recorded as such in
§2.

---

## 1. What is wrong

`bookings` has no `lead_id`. The link between a call and the person who booked
it is reconstructed at read time from `(funnel_id, lower(email))` — `bookingKey`
in `lib/contacts.ts`, used by `api/calendar/index.ts`, `api/contacts/index.ts`,
`api/contacts/[leadId].ts` and `api/leads/[leadId]/outcome.ts`.

**The writer already knows the answer and throws it away.** `api/calendar/book.ts:142`
resolves the lead at booking time:

```ts
async function logFunnelBooked(funnelId: string, email: string): Promise<string | null>
```

It returns a real lead id, the caller holds it in `leadId` at line 368, passes it
to the confirmation email and to `cancelLeadOutreach` — and then inserts the
booking row without it (line 271). Every read site downstream then spends a join
re-deriving a fact that was in scope, in the same function, moments earlier.

This is the same defect one layer deeper than the two already fixed this week:

- **The coach-calendar-scope fix** — coach-page bookings never reached the
  coach's calendar, because ownership was inferred from `funnel_id` instead of
  being stated.
- **The contacts fix** — the same bookings never reached the person, because the
  *join* could not express "this call, that lead" when there was no funnel to
  join on.

Both were fixed by adding a second read path. Neither removed the reason a
second path was needed: the row does not say who it belongs to.

---

## 2. What the column MEANS

**`lead_id` is the lead this booking was created from, known at write time.
Nothing else. A value in that column is a record, never a derivation.**

This is the definition, and it settles the backfill question permanently rather
than deferring it. A backfill that resolves by email across a coach's funnels is
the `lib/contacts.ts` heuristic written into a column. The moment it lands, no
reader can distinguish a recorded fact from a good guess, because both are a
uuid in the same field. That is worse than null: **null is honest about not
knowing; a guessed uuid is confidently wrong in a way nothing downstream can
detect.**

It is the same sentence as §8.4 of the Client Programs brief, one table over.
There, `discovery_call_count` uses the `(coach, email)` match the schema calls a
trap, **deliberately, for display, and it must never migrate into the allowance
calculation** — same query, opposite consequences. Here, the same heuristic is
right for attributing a call to a contact on screen and wrong for asserting a
foreign key. **Same query, opposite consequences.** The two decisions are one
decision and are worded the same way on purpose.

### The consequence, which is correct rather than a gap

Coach-page bookings will keep landing with `lead_id` null forever, because there
is no funnel to resolve from at write time. That is right. **A coach-page booking
is created from no lead.** The person may well *be* a lead somewhere in that
coach's funnels, but this call did not come from there, and the column records
**provenance, not identity**. `lib/contacts.ts` keeps doing the attribution work,
permanently, and that is not a stopgap.

If someone later wants coach-page rows resolved, the argument they have to make
is that **the meaning should change** — not that a backfill was overdue.

---

## 3. Why the join is not equivalent to a column

Four ways it is already lossy, in decreasing order of how much they bite:

1. **A coach-page booking has no funnel to join on.** `bookingKey` maps a null
   funnel to `''`, so those rows are excluded from the funnel keyspace entirely.
   `lib/contacts.ts` compensates with a second rule — email alone, within the
   coach's own leads, most-recently-created lead wins — which is a *heuristic*
   standing in for a fact. It is right today. It is not the same kind of thing.
2. **A person can be a lead in two of one coach's funnels.** Then "which lead
   booked" has two answers and the reader picks one. `api/calendar/index.ts`
   documents this at length and deliberately picks differently from
   `lib/contacts.ts` — suppression there, attribution here. Two correct answers
   to the same question, which is only sustainable while somebody remembers why.
3. **The email can change.** `funnel_leads.email` is editable through the CRM. A
   lead who corrects a typo silently detaches from every call they have already
   had, and nothing anywhere reports it.
4. **The two sides disagree about case.** `bookingKey` lowercases;
   `logFunnelBooked` uses `.eq('email', email)`, which does not. Production has
   zero mixed-case addresses today so the discrepancy is invisible — a guard
   shaped like a container, passing until real data shares it. **This is fixed in
   the same commit; see §5.3.**

---

## 4. What production actually looks like

Measured, not assumed. Read-only, `select` only.

| | count |
|---|---|
| `bookings` rows | 11 |
| with `funnel_id` | 3 |
| funnel-less | 8 |
| of those, also `coach_user_id is null` | 6 |
| addresses that are not already lowercase | 0 |
| distinct addresses across all bookings | 5 |

**Backfill coverage, by rule:**

| rule | resolves | ambiguous | unresolved |
|---|---|---|---|
| `(funnel_id, lower(email))` on the 3 funnel rows | **3** | 0 | 0 |
| coach's funnels + `lower(email)` on the 8 funnel-less rows | 0 | 0 | 8 |

The second row is measurement, not a proposal — **that rule is not being
written** (§2). It is recorded so nobody re-derives it later and mistakes the
zero for an oversight.

So the backfill sets 3 of 11 and leaves 8 null. Six of those eight are correctly
null forever.

**This is the strongest argument for doing it now and the reason to be careful
about the column's meaning.** Eleven rows is the cheapest this migration will
ever be. But it also means the backfill cannot be validated by its own results —
3 of 11 succeeding tells you almost nothing.

---

## 5. The proposal

### 5.1 Migration `096_bookings_lead_id.sql`

Re-read `supabase/migrations/` before writing the number; 095 is the current
head, but v1 of the Client Programs brief said `084`/`085` and was wrong within a
day.

```sql
-- lead_id is the lead this booking was CREATED FROM, known at write time.
-- A value here is a record, never a derivation: nothing may resolve it from a
-- read-time (coach, email) match, because a guessed uuid is indistinguishable
-- from a recorded one and null is the honest answer to not knowing.
-- Same rule as discovery_call_count in the Client Programs brief §8.4 — that
-- match is right for display and wrong for asserting a foreign key.
--
-- funnel_id STAYS. It is not derivable from this column: bookings.funnel_id
-- records which funnel produced this call at the moment it was booked, while
-- lead_id -> funnel_leads.funnel_id reports which funnel that lead sits in NOW.
-- A lead can be edited, moved or deleted and the second value changes while the
-- first must not. They agree today, which is exactly the condition under which a
-- second fact looks like duplication. Secondarily, it is the only funnel signal
-- left on a row whose lead is later deleted.
alter table bookings
  add column if not exists lead_id uuid references funnel_leads(id) on delete set null;

create index if not exists idx_bookings_lead_id on bookings (lead_id) where lead_id is not null;
```

**`on delete set null`, not `cascade`.** Deleting a lead must not delete the call
they had — the call happened, and the coach's calendar history is a record of it.
Cascade would silently rewrite history when someone tidies their CRM.

**Nullable, and it stays nullable.** Null means *this call was created from no
lead*, which is the true and permanent state of six rows in production right now
and of every future coach-page booking. A `not null` constraint would be a claim
that every call comes from a funnel — exactly the assumption that broke the coach
calendar.

**Partial index**, because the majority of rows are null and every query that
reads this column reads it for a non-null value.

### 5.2 Backfill — separate statement, separate review

```sql
update bookings b
set lead_id = l.id
from funnel_leads l
where b.lead_id is null
  and b.funnel_id is not null
  and l.funnel_id = b.funnel_id
  and lower(btrim(l.email)) = lower(btrim(b.email))
  and not exists (
    select 1 from funnel_leads l2
    where l2.funnel_id = b.funnel_id
      and lower(btrim(l2.email)) = lower(btrim(b.email))
      and l2.id <> l.id
  );
```

**Only the unambiguous funnel case.** The `not exists` clause refuses any booking
whose address matches two leads on the same funnel rather than picking the newer
one. A backfill is a one-off write with no reader to correct it, so it should
only assert what it is certain of.

**The coach-page rule is not written** — see §2. Not deferred; excluded by
definition.

**Expect 3.** Run inside `begin; … rollback;` first and state the count before
applying. **If it is not 3, stop and report — do not investigate inside the
transaction.** A number other than 3 means the data changed since this brief was
measured, and the right response is a fresh measurement, not a live diagnosis.

### 5.3 Writers — three sites, and the case fix is mandatory

| site | change |
|---|---|
| `api/calendar/book.ts:271` (funnel + coach-page path) | set `lead_id: leadId` — already in scope from `logFunnelBooked` |
| `api/calendar/book.ts:546` (shared-Zoom legacy path) | leave null; the comment at line 583 already states there is no lead to match |
| `api/client-programs/[id]/requests/[requestId].ts:95` | set `lead_id: program.lead_id` — the programme already carries it, and it is null for a lead-less programme, which is correct |

**And `logFunnelBooked` must match the way `bookingKey` matches, in the same
commit.** Case-sensitive on one side and lowercasing on the other is a guard
shaped like a container, passing only because production holds no mixed-case
addresses. §6 item 1's capital-letter fixture is the test that proves it.

### 5.4 Readers — NOT in this change

Leave every read site on the existing join. Adding the column and switching the
readers in one commit means a reader regression and a column bug are the same
change, and the backfill only covers 3 of 11 rows — so a reader that trusted
`lead_id` alone would lose the two funnel-less-but-coached rows that the
heuristic currently finds.

The reader migration is its own step, and it is **not** "replace the join". It is
*prefer the column, fall back to the join*, and — given §2 — **the fallback is
permanent for coach-page rows**, not a transitional state to be deleted later.

---

## 6. What must be true before this is called done

The property, in words: **a booking's lead is recorded, not inferred — and where
it cannot be recorded, the absence is explicit rather than a join returning
nothing.**

1. `lower(btrim(email))` matched on both sides everywhere, asserted against a
   fixture with a capital letter in the address. Today's zero mixed-case rows are
   why this cannot be checked against production data, and it is the test that
   proves §5.3's case fix.
2. A fixture where one address is a lead on **two** of one coach's funnels, and
   the backfill predicate is asserted to write **nothing** for it.
3. A fixture with a coach-page booking (`funnel_id is null`,
   `coach_user_id` set), asserted to keep `lead_id` null through the backfill —
   and asserted still to appear in `api/contacts` via the existing heuristic, so
   the fix does not regress the fix.
4. A booking whose lead is deleted: assert the booking survives with `lead_id`
   null. `on delete set null` is a claim about the database, and the only way to
   know it is what the database does is to make it happen.
5. A test that the two writers agree. `book.ts` and the session-request confirm
   both set this column, from different sources, and nothing in the type system
   connects them.
6. **The writers are BOUNDED, by name.** Assert that exactly two sites write
   `lead_id` on `bookings` — `api/calendar/book.ts` and
   `api/client-programs/[id]/requests/[requestId].ts` — and that
   `lib/contacts.ts` is not one of them. A grep-shaped assertion is right here:
   the thing being guarded is that a third writer does not appear quietly, and
   §2's whole meaning collapses the moment a read-time heuristic starts writing
   this column. Same shape as the public-writer sweep in
   `tests/publicWriteRateLimit.test.ts` — name the set, so a new member is a
   decision somebody has to make rather than a default they inherit.

---

## 7. Decisions taken (rev 1's open questions, answered 2026-08-08)

1. **The coach-page backfill rule is not written, and that is a definition, not a
   deferral.** Recorded in §2 as the column's meaning, in the same words as the
   Client Programs §8.4 rule so the two are visibly one decision.
2. **`funnel_id` stays**, and the reason is that it is *not the same fact* —
   provenance at booking time versus the lead's current funnel. "It survives lead
   deletion" is true and is kept as the second reason, not the first. One line in
   the migration comment says so, so nobody reads the derived-values convention
   in `CLAUDE.md` and drops it as duplication.
3. **This goes first; no frontend coordination is needed.** A nullable column
   with no reader is invisible to `client-atm-frontend`. It is done now rather
   than after Steps 1–3 for §4's reason: eleven rows is the cheapest this will
   ever be, and it is the one piece of Client Programs-adjacent work that gets
   more expensive by waiting.
