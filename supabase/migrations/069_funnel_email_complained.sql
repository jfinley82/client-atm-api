-- Distinct spam-complaint tracking, backing the email health score's spam_rate.
--
-- api/webhooks/resend.ts previously treated email.complained identically to
-- email.bounced (status='failed', bounced_at stamped) — losing the distinction
-- between "never delivered" (bounce) and "delivered, then marked as spam"
-- (complaint). A spam complaint requires the email to have been delivered, so
-- conflating it with a bounce corrupted both bounce_pct and any complaint rate.
alter table funnel_email_sends add column if not exists complained_at timestamptz;
