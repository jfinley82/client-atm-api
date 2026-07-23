-- Build wizard email suite: the pre-opt-in warm-list invite sequence. Additive
-- jsonb, defaults empty; existing rows keep working (the other two email
-- sequences — emails, book_a_call_emails — already exist).
alter table mtm_generations add column if not exists warm_invite_emails jsonb default '[]'::jsonb;  -- 3 pre-opt-in warm-list invites
