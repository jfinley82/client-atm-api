-- Coach notifications (new booking / application / opt-in). Additive only:
-- one new jsonb prefs column on the existing per-coach settings table, plus a
-- timestamp marker on each row an event fires from so a send is exactly-once
-- (same *_sent_at idempotency shape funnel_email_sends already uses).
--
-- Bookings and applications are high-signal for a coach, so they default on;
-- opt-ins can be high-volume (every landing-page signup), so default off.
alter table funnel_business_settings add column if not exists notification_prefs jsonb not null
  default '{"new_booking": true, "new_application": true, "new_optin": false}'::jsonb;

-- Claimed via `update ... where coach_notified_at is null`, so a retry/re-run of
-- the same booking can never send the notice twice.
alter table bookings add column if not exists coach_notified_at timestamptz;

-- Same exactly-once claim, scoped per event type — a lead can opt in once and
-- later submit an application, and each is its own notice, so these need
-- separate markers rather than one shared column.
alter table funnel_leads add column if not exists application_notified_at timestamptz;
alter table funnel_leads add column if not exists optin_notified_at timestamptz;
