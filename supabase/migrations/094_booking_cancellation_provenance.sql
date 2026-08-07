-- 094_booking_cancellation_provenance.sql
--
-- WHEN a booking was cancelled, and BY WHOM.
--
-- Neither is recordable today, so "cancelled early or late" is currently
-- unknowable for every booking in the system — and so is "did the client give
-- the slot back, or did the coach take it away". Those are different facts with
-- opposite consequences the moment a session allowance depends on them: a
-- client who cancels in good time gets the session back, and a client whose
-- coach cancelled must never be charged for it.
--
-- Worth adding on its own merits, independent of client programs, which is why
-- this ships alone and first. A rollback of the client-programs work must not
-- take the booking flow with it.
--
-- NOTE ON SCOPE. The build brief put `bookings.program_id` in this migration as
-- well. It cannot go here: its foreign key targets `client_programs`, which
-- does not exist until the next migration, so this one would fail to apply on
-- its own — which is the one thing a migration designed to ship independently
-- must not do. program_id moves to the client_programs migration, where its
-- target exists, and it is the right home anyway: the column is meaningless
-- until there is a program to point at.

alter table bookings add column if not exists canceled_at timestamptz;

-- 'client'  — the attendee gave the slot back through
--             api/funnel/booking/cancel.ts, which refuses inside
--             MANAGE_CUTOFF_MS, so every row it writes is an early cancel by
--             construction.
-- 'coach'   — the meeting was deleted in Zoom (api/zoom/webhook.ts). No cutoff
--             applies, so this is the only way a LATE cancellation enters the
--             system.
-- 'system'  — reserved: an automated cancellation with no human behind it.
--             Nothing writes it yet; it exists so that adding one later is not
--             a migration.
--
-- text + CHECK rather than an enum: widening a CHECK is one migration,
-- widening an enum type is not.
alter table bookings add column if not exists canceled_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_canceled_by_check') then
    alter table bookings
      add constraint bookings_canceled_by_check
      check (canceled_by is null or canceled_by in ('client', 'coach', 'system'));
  end if;
end $$;

-- Existing canceled rows keep NULL on both, and that is the honest state: we do
-- not know when they were cancelled or by whom. Do NOT backfill from
-- created_at or start_time — inventing a timestamp is worse than admitting one
-- is missing, and any rule that reads these must treat NULL as UNKNOWN rather
-- than as a value.

comment on column bookings.canceled_at is
  'When the cancellation happened. NULL on rows cancelled before 2026-08-07 — unknown, not "never".';
comment on column bookings.canceled_by is
  'client | coach | system. NULL on rows cancelled before 2026-08-07 — unknown, not "nobody".';
