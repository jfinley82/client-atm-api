-- Snapshot of the booker's answers to the admin-defined custom questions,
-- captured at booking time. Stored as a self-contained array of
-- { id, label, type, answer } so a booking keeps its full context even if the
-- question definitions are later edited or deleted. Nullable — bookings made
-- before any custom questions existed simply have no answers.
alter table bookings add column if not exists custom_answers jsonb;
