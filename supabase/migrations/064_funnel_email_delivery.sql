-- Delivery state per funnel email, so GET /api/funnels/[id]/emails can report a
-- real delivered %.
--
-- The Resend webhook (048) already records opens, clicks, bounces and complaints,
-- but nothing about DELIVERY: funnel_email_sends.status only distinguishes
-- queued / sent / canceled / failed, and a SCHEDULED send is written 'queued' and
-- never moves — Resend's own email.sent fires later and had no handler. So a
-- funnel whose sends are mostly scheduled looked as if almost nothing had gone
-- out, and "delivered %" had no source at all.
--
-- Timestamps rather than more status values: the states are not exclusive (an
-- email is sent AND delivered AND opened), and a nullable timestamp records both
-- whether and when. status keeps its existing meaning untouched.
alter table funnel_email_sends add column if not exists sent_at timestamptz;
alter table funnel_email_sends add column if not exists delivered_at timestamptz;
alter table funnel_email_sends add column if not exists bounced_at timestamptz;

-- The analytics feed groups by (funnel_id, kind).
create index if not exists idx_funnel_email_sends_funnel_kind on funnel_email_sends (funnel_id, kind);

comment on column funnel_email_sends.sent_at is
  'When Resend actually dispatched it (email.sent). NULL for a send still scheduled in the future.';
comment on column funnel_email_sends.delivered_at is
  'When the receiving server accepted it (email.delivered). The denominator for open/click rates.';
comment on column funnel_email_sends.bounced_at is
  'When it hard-bounced or was complained about. The lead is suppressed at the same time.';
