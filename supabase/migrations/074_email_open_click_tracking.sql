-- Email opens & clicks as first-class columns on the send row.
--
-- Engagement was already being captured — the Resend webhook writes
-- funnel_events 'email_opened'/'email_clicked' rows (migration 048) and the
-- Emails endpoint reads them. What was missing is that those events live in a
-- DIFFERENT table from the sends they belong to, so the numerator and the
-- denominator of the open rate come from two different populations: every open
-- ever recorded, divided by only those sends whose delivery webhook landed.
-- On live data that yields 8 opens over 1 delivered nurture_1 (800%) and opens
-- over 0 delivered reminders (null, rendered "—"). Neither is a real rate.
--
-- Stamping engagement onto the send row itself makes both sides of the ratio
-- the same set of rows, so a rate can no longer exceed 100% or vanish.
alter table funnel_email_sends add column if not exists opened_at timestamptz;
alter table funnel_email_sends add column if not exists clicked_at timestamptz;
alter table funnel_email_sends add column if not exists open_count int not null default 0;
alter table funnel_email_sends add column if not exists click_count int not null default 0;

-- One atomic statement per webhook event, for two reasons the client library
-- cannot give us in a plain .update():
--   * first-touch is preserved by coalesce(), so a repeat open/click can never
--     move opened_at/clicked_at — idempotent by construction, not by a
--     read-then-write that could race two simultaneous pixel fires.
--   * the counters increment off their own current value rather than a value
--     the caller read a round-trip earlier, so concurrent opens can't lose a
--     count to a lost update.
-- Returns the send's funnel/lead/kind so the webhook still has what it needs to
-- write its funnel_events row, without a second lookup query. Zero rows back
-- means no send matched that message id (e.g. a non-funnel email) — the caller
-- treats that exactly as it treats a lookup miss today.
create or replace function record_email_engagement(
  p_message_id text,
  p_event text,
  p_at timestamptz
)
returns table (funnel_id uuid, lead_id uuid, kind text)
language sql
as $$
  update funnel_email_sends set
    opened_at   = case when p_event = 'opened'  then coalesce(opened_at, p_at) else opened_at end,
    open_count  = case when p_event = 'opened'  then open_count + 1 else open_count end,
    clicked_at  = case when p_event = 'clicked' then coalesce(clicked_at, p_at) else clicked_at end,
    click_count = case when p_event = 'clicked' then click_count + 1 else click_count end
  where resend_message_id = p_message_id
  returning funnel_email_sends.funnel_id, funnel_email_sends.lead_id, funnel_email_sends.kind;
$$;
