-- Inbound email replies (Phase 1b): a webhook redelivery of the same
-- email.received event must not append the same reply twice. resend_email_id
-- is the inbound message's own id (Resend's receiving-email id, distinct from
-- the outbound message id it may be replying to), recorded only on rows
-- created from an inbound reply — null for every admin-typed or member-typed
-- (in-app) message, so the partial unique index costs nothing on those.
alter table support_ticket_messages add column if not exists resend_email_id text;

create unique index if not exists idx_support_ticket_messages_resend_email_id
  on support_ticket_messages (resend_email_id)
  where resend_email_id is not null;
