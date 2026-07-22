-- Phase 3b follow-up — lead-side reschedule cap. A per-booking counter so a lead
-- can't endlessly shuffle their call; the reschedule endpoint refuses at 2 and
-- increments atomically (compare-and-swap on this column) so two concurrent
-- moves can't both slip past the cap. Cancel stays uncapped. Verified live:
-- bookings had no such column.
alter table bookings add column if not exists reschedule_count integer not null default 0;
