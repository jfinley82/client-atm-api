-- The selected training ANGLE's hook/positioning text, persisted alongside
-- chosen_topic so every generated asset can be grounded in the same fixed hook
-- (not just the title). Resolved from the selected topics[] entry when the coach
-- picks a title. Additive; existing rows default empty and fall back to resolving
-- the angle from the stored topics by matching chosen_topic.
alter table mtm_generations add column if not exists chosen_angle text default ''::text;
