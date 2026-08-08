# Brief — `bookings.lead_id`

**Status: WRITTEN, NOT APPLIED.** Nothing in here has touched production. No
migration file exists yet. This is for review before anything does.

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

## 2. Why the join is not equivalent to a column

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
   shaped like a container, passing until real data shares it.

## 3. What production actually looks like

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
| coach's funnels + `lower(email)` on the 8 funnel-less rows | **0** | 0 | 8 |

So a backfill sets 3 of 11 and leaves 8 null. **Six of those eight are correctly
null forever** — they have no coach either, which makes them MTM's own `/book`
discovery calls, booked by people who were never a lead in anyone's funnel. The
remaining two have a coach but no matching lead in any of that coach's funnels.

**This is the strongest argument for doing it now and the reason to be careful
about the column's meaning.** Eleven rows is the cheapest this migration will
ever be. But it also means the backfill cannot be validated by its own results —
3 of 11 succeeding tells you almost nothing, and 0 of 8 succeeding on the
coach-page rule tells you the rule is untested rather than that it works.

## 4. The proposal

### 4.1 Migration `096_bookings_lead_id.sql`

Re-read `supabase/migrations/` before writing the number; 095 is the current
head, but v1 of the Client Programs brief said `084`/`085` and was wrong within a
day.

```sql
alter table bookings
  add column if not exists lead_id uuid references funnel_leads(id) on delete set null;

create index if not exists idx_bookings_lead_id on bookings (lead_id) where lead_id is not null;
```

**`on delete set null`, not `cascade`.** Deleting a lead must not delete the call
they had — the call happened, the coach's calendar history is a record of it, and
`sessions_used` counts by `program_id` but `needs_outcome` counts calls. Cascade
would silently rewrite history when someone tidies their CRM.

**Nullable, and it stays nullable.** Null means *this call has no lead*, which is
the true and permanent state of six rows in production right now. A `not null`
constraint would be a claim that every call comes from a funnel, which is exactly
the assumption that broke the coach calendar.

**Partial index**, because the majority of rows are null today and every query
that reads this column reads it for a non-null value.

### 4.2 Backfill — separate statement, separate review

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
only assert what it is certain of; the readers already have a documented
tie-break for the ambiguous case and can keep using it.

**The coach-page rule is NOT backfilled.** It resolves nothing on today's data,
which means running it would be running an untested rule against production for
no benefit. If it is wanted later it is its own statement with its own review.

Validate inside `begin; … rollback;` first and report the row count before
applying. Expect **3**.

### 4.3 Writers

Three sites insert into `bookings`:

| site | change |
|---|---|
| `api/calendar/book.ts:271` (funnel + coach-page path) | set `lead_id: leadId` — it is already in scope from `logFunnelBooked` |
| `api/calendar/book.ts:546` (shared-Zoom legacy path) | leave null; the comment at line 583 already states there is no lead to match |
| `api/client-programs/[id]/requests/[requestId].ts:95` | set `lead_id: program.lead_id` — the programme already carries it, and it is null for a lead-less programme, which is correct |

And fix the case discrepancy in the same commit: `logFunnelBooked` must match the
way `bookingKey` matches, or the column and the join disagree on exactly the row
that has a capital letter in it.

### 4.4 Readers — NOT in this change

Leave every read site on the existing join. Adding the column and switching the
readers in one commit means a reader regression and a column bug are the same
change, and the backfill only covers 3 of 11 rows — so a reader that trusts
`lead_id` alone would lose the two funnel-less-but-coached rows that the
heuristic currently finds.

The reader migration is its own step, and it is **not** "replace the join". It is
*prefer the column, fall back to the join*, until a sweep shows the fallback
never fires. Deleting the fallback before that is deleting the only thing that
covers the rows the backfill could not.

## 5. What must be true before this is called done

The property, in words: **a booking's lead is recorded, not inferred — and where
it cannot be recorded, the absence is explicit rather than a join returning
nothing.**

1. `lower(btrim(email))` matched on both sides everywhere, asserted against a
   fixture with a capital letter in the address. Today's zero mixed-case rows are
   why this cannot be checked against production data.
2. A fixture where one address is a lead on **two** of one coach's funnels, and
   the backfill predicate is asserted to write **nothing** for it.
3. A fixture with a coach-page booking (`funnel_id is null`,
   `coach_user_id` set), asserted to keep `lead_id` null through the backfill —
   and asserted still to appear in `api/contacts` via the existing heuristic, so
   the fix does not regress the fix.
4. A booking whose lead is deleted: assert the booking survives with
   `lead_id` null. `on delete set null` is a claim about the database, and the
   only way to know it is what the database does is to make it happen.
5. A test that the two writers agree. `book.ts` and the session-request confirm
   both set this column, from different sources, and nothing in the type system
   connects them.

## 6. What I am not sure about, and would want your call on

- **Whether the coach-page backfill rule should exist at all.** It resolves
  nothing today, so writing it now means shipping an unexercised rule. But the
  longer it is deferred, the more rows accumulate that it would have caught, and
  the heuristic in `lib/contacts.ts` is doing that work in the meantime — which
  is an argument for leaving it doing that work permanently and letting `lead_id`
  mean strictly "resolved from the funnel".
- **Whether `funnel_id` should stay on `bookings` afterwards.** It is
  recoverable through `lead_id -> funnel_leads.funnel_id` for every row that has
  one, so it becomes derivable data stored — which the conventions in `CLAUDE.md`
  argue against. But it is also the only funnel signal on a row whose lead is
  later deleted, and dropping a column is not one migration if it turns out to be
  wrong. My inclination is to keep it and say why in a comment.
- **Ordering against the frontend.** Nothing in `client-atm-frontend` reads
  `bookings.lead_id` because it does not exist. Adding it is invisible to that
  repo until a reader changes shape, so this can go first — but that repo is
  another session's and the sequencing is yours to decide.
