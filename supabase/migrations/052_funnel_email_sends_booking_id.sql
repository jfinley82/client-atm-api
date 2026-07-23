-- Scope booking reminders to the booking. Today the 24h/1h reminders in
-- funnel_email_sends are keyed only by (lead, funnel, kind), so canceling one
-- booking would cancel a lead's reminders across ALL their bookings. Add a
-- booking_id so reminder rows can be canceled per booking. Nullable — nurture /
-- book-a-call rows leave it null.
alter table funnel_email_sends
  add column if not exists booking_id uuid references bookings(id) on delete cascade;

create index if not exists idx_funnel_email_sends_booking on funnel_email_sends (booking_id);
