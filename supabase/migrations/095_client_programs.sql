-- 095_client_programs.sql
--
-- Client Programs: what a coach delivers AFTER a lead converts.
--
-- Four tables plus the booking link. Written as one migration because they are
-- one unit — every table here is meaningless without client_programs, and
-- bookings.program_id's foreign key targets a table created a few lines above
-- it. That is why it could not live in 094: a migration must apply on its own.
--
-- text + CHECK rather than Postgres enums throughout, matching the rest of this
-- schema (funnel_leads.status, bookings.attended, support_tickets.stage).
-- Widening a CHECK is one migration; widening an enum type is not.
--
-- NO RLS. These tables are read and written by the service-role client, and RLS
-- in this schema exists only on storage buckets, so an auth.uid() policy here
-- would be silently bypassed rather than enforced. Ownership is checked in the
-- handler, which is where every other table in this database enforces it.

-- ---------------------------------------------------------------------------
-- The program itself
-- ---------------------------------------------------------------------------
create table if not exists client_programs (
  id                    uuid primary key default gen_random_uuid(),

  -- The COACH. on delete cascade: a deleted coach takes their clients' programs
  -- with them, because a program with no coach cannot be delivered by anyone.
  user_id               uuid not null references users(id) on delete cascade,

  -- Where this client came from, when they came from a funnel. set null rather
  -- than cascade: deleting a lead record must not destroy a running program —
  -- the client is a real person either way, and the lead row is only their
  -- origin story.
  lead_id               uuid references funnel_leads(id) on delete set null,

  client_name           text not null,
  client_email          text not null,

  -- IANA zone for the CLIENT, not the coach. Reminder mail resolves its send
  -- hour here, because it is the client who reads it. NULL means UNKNOWN, and
  -- the reader substitutes UTC at read time — it does not mean "this client is
  -- in UTC", and nothing should backfill it as though it did.
  client_timezone       text,

  -- SNAPSHOT of the coach's program at the moment this client started, never a
  -- live read. saved_outputs is UNIQUE(user_id, tool_type) — verified in
  -- production — so there is exactly ONE program row per coach. Reading it live
  -- would mean a coach editing their program silently rewrites the plan of every
  -- client already running on the old one, mid-flight.
  program_snapshot      jsonb not null,
  program_name          text not null,

  -- Bounds mirror MIN_WEEKS/MAX_WEEKS in lib/programReshape.ts, which is what
  -- decides the legal lengths a program can be reshaped to. They are asserted
  -- against each other in tests/clientProgramsMigration.test.ts rather than left
  -- to agree by memory: if this CHECK is narrower than the code, a coach reshapes
  -- to a length the database then refuses, and the failure surfaces at create
  -- time on a real client.
  total_weeks           integer not null check (total_weeks between 1 and 16),

  -- Calls the client is entitled to, INDEPENDENT of total_weeks. Twelve weeks
  -- may be four monthly calls plus email support, so this cannot be derived from
  -- the week count. 0 is legal and means a program with no calls in it, which is
  -- a real product, not a misconfiguration.
  sessions_allowed      integer not null default 0 check (sessions_allowed between 0 and 200),

  start_date            date not null,

  -- 'draft' is the CREATED state: nothing is mailed, and the portal token does
  -- not resolve. The coach reviews, resequences and adds tasks, then sending
  -- moves draft -> active. That ordering is what makes editing safe — there is
  -- no window where a client can see a half-built plan.
  --
  -- Sending is one-way. There is no active -> draft, because once the client
  -- holds the link, un-sending it is a fiction.
  --
  -- 'canceled', ONE L, matching bookings.status in production. The two are read
  -- side by side and a spelling split here would be invisible until a query
  -- returned nothing.
  status                text not null default 'draft'
                          check (status in ('draft', 'active', 'completed', 'paused', 'canceled')),

  -- Bumped to invalidate every portal link previously issued for this program —
  -- the client's only credential, so revocation has to be possible without
  -- deleting the program.
  portal_token_version  integer not null default 1,

  -- Written fire-and-forget when the client opens their portal. Answers "is this
  -- client actually using it", which is the question a coach asks before
  -- following up. NULL means never opened OR opened before this column existed;
  -- it does not mean "not engaged".
  portal_last_opened_at timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  activated_at          timestamptz,
  completed_at          timestamptz
);

-- One program per lead per coach. Partial, because a client added by hand has no
-- lead_id and any number of those may exist — NULLs are distinct in a plain
-- unique index anyway, but stating the predicate makes the intent legible.
create unique index if not exists uq_client_programs_lead
  on client_programs (user_id, lead_id) where lead_id is not null;

-- The coach's own list, which is the only way this table is browsed.
create index if not exists idx_client_programs_owner
  on client_programs (user_id, status, start_date desc);


-- ---------------------------------------------------------------------------
-- What the client actually does
-- ---------------------------------------------------------------------------
create table if not exists client_program_items (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references client_programs(id) on delete cascade,
  kind          text not null check (kind in ('week', 'task', 'milestone')),

  -- POSITION AND IDENTITY ARE SEPARATE, and this is the whole reason both
  -- columns exist.
  --
  -- sequence_position: where this sits in THIS client's journey. Drives due
  --   dates. A client who starts at the coach's week 4 has it at position 1.
  -- source_week: which snapshot week it came from. NEVER renumbered, so the
  --   portal can still say "week 4 of your coach's method" while showing it as
  --   the client's week 1.
  --
  -- At creation the two are equal everywhere. They diverge only on resequence,
  -- which is exactly when conflating them would start lying.
  sequence_position integer not null check (sequence_position >= 1),
  source_week       integer check (source_week >= 1),
  sort_order        integer not null default 0,

  title         text not null,
  detail        text,
  phase_name    text,

  due_date      date,

  -- 'derived'  = computed from sequence_position + start_date, and therefore
  --              SAFE to recompute.
  -- 'manual'   = a coach typed this date, and recomputation must leave it alone.
  --
  -- Without this column, moving start_date or compacting a deleted week silently
  -- overwrites every date the coach set by hand, and there is no way afterwards
  -- to tell which ones those were.
  due_date_source text not null default 'derived'
                    check (due_date_source in ('derived', 'manual')),

  status        text not null default 'pending' check (status in ('pending', 'completed')),
  completed_at  timestamptz,
  -- WHO ticked it. A coach marking work done on a client's behalf and a client
  -- marking their own are different facts, and only one of them is evidence of
  -- engagement. NULL while pending.
  completed_by  text check (completed_by in ('coach', 'client')),

  -- The scheduled reminder for this item, so it can be cancelled if the item is
  -- deleted or completed early. Same role resend_message_id plays for the
  -- booking reminders.
  reminder_message_id text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The portal and the coach's detail view both read a whole program in display
-- order, which is this.
create index if not exists idx_client_program_items_program
  on client_program_items (program_id, sequence_position, sort_order);


-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------
create table if not exists client_program_notes (
  id           uuid primary key default gen_random_uuid(),
  program_id   uuid not null references client_programs(id) on delete cascade,
  body         text not null,

  -- IMMUTABLE after insert, enforced in the handler. A note written in
  -- confidence must not become client-visible by a later edit — the coach wrote
  -- it under one audience and cannot re-consent retroactively. Changing who can
  -- see something means writing a new note, not amending an old one.
  visibility   text not null check (visibility in ('coach_only', 'coach_and_client')),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_client_program_notes_program
  on client_program_notes (program_id, created_at desc);


-- ---------------------------------------------------------------------------
-- The client asking for a call
-- ---------------------------------------------------------------------------
create table if not exists client_program_session_requests (
  id             uuid primary key default gen_random_uuid(),
  program_id     uuid not null references client_programs(id) on delete cascade,

  -- WHICH milestone this call fulfils, when the client requested it from one.
  -- Nullable in both directions by design: an ad-hoc call has no item, and most
  -- milestones are not calls at all.
  --
  -- This is the ONLY join between an item and a booking. Without it a milestone
  -- has no clock time (due_date is a `date`, which has no time of day) and a
  -- booking has no title, so neither the coach's detail view nor the client's
  -- portal can render "Week 6 check-in call, Thursday 2:00pm" — it would have
  -- half the sentence from each side and no way to connect them.
  item_id        uuid references client_program_items(id) on delete set null,

  note           text,
  preferred_1    timestamptz,
  preferred_2    timestamptz,

  status         text not null default 'requested'
                   check (status in ('requested', 'confirmed', 'declined', 'withdrawn')),

  -- The booking this became, once confirmed. set null on delete so cancelling a
  -- booking does not erase the request that produced it.
  booking_id     uuid references bookings(id) on delete set null,
  decline_reason text,

  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

-- At most ONE open request per program. A client who taps twice gets one
-- request, not a queue the coach has to reconcile — enforced here rather than in
-- the handler because two concurrent taps would both pass a read-then-write
-- check.
create unique index if not exists uq_session_request_open
  on client_program_session_requests (program_id) where status = 'requested';

create index if not exists idx_session_requests_program
  on client_program_session_requests (program_id, created_at desc);


-- ---------------------------------------------------------------------------
-- The booking link
-- ---------------------------------------------------------------------------
-- Set ONLY when confirming a client_program session request. NULL for every
-- funnel and discovery booking, past and future.
--
-- This is what STRUCTURALLY excludes discovery calls from a client's session
-- count: they are not filtered out of the set, they were never in it. The
-- alternative — counting by (coach_user_id, email), which is the match
-- lib/bookingManage.ts is forced into because bookings has no lead_id — would
-- charge a client's pre-program discovery calls against the allowance they
-- bought. A filter can be forgotten at one call site; an absent row cannot.
--
-- Lives here rather than in 094 because its foreign key targets client_programs,
-- which is created above. 094 had to be appliable alone.
alter table bookings add column if not exists program_id uuid
  references client_programs(id) on delete set null;

-- Partial: the overwhelming majority of bookings are funnel bookings and carry
-- NULL here, and the only query this serves is "sessions used by this program".
create index if not exists idx_bookings_program on bookings (program_id)
  where program_id is not null;

comment on column bookings.program_id is
  'The client_program this session was booked against. NULL = not a program session (every funnel/discovery booking). Never filter to exclude discovery calls; they are absent from the set by construction.';
