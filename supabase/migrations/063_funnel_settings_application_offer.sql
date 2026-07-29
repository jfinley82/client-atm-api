-- Schema for the funnel workspace build-out: per-funnel Settings, the application
-- gate, post-call attendance, and sell mode. One migration for all of it so the
-- feature work that follows needs no further schema round-trips.

-- ── 1. Settings surface ─────────────────────────────────────────────────────
-- Brand fonts split into headline/body (funnel_business_settings.brand_font is a
-- single account-level font; these are the per-funnel pair the Settings tab edits).
alter table funnels add column if not exists brand_headline_font text;
alter table funnels add column if not exists brand_body_font text;

-- Cookie notice is a per-funnel legal toggle; the render already draws the notice
-- unconditionally, so default TRUE preserves today's behaviour exactly.
alter table funnels add column if not exists cookie_notice_enabled boolean not null default true;

-- ── 2. Sell mode ────────────────────────────────────────────────────────────
-- book  = training CTA goes to the booking calendar (today's only behaviour)
-- sell  = training CTA goes straight to offer_url; no calendar is rendered
alter table funnels add column if not exists cta_mode text not null default 'book';
alter table funnels drop constraint if exists funnels_cta_mode_check;
alter table funnels add constraint funnels_cta_mode_check check (cta_mode in ('book', 'sell'));

alter table funnels add column if not exists offer_url text;
alter table funnels add column if not exists offer_button_text text;
-- Display string (e.g. "$1,497"). The conversion pixel can also be handed a real
-- numeric amount; this is the fallback when it is not.
alter table funnels add column if not exists offer_price_display text;

-- ── 3. Application gate ─────────────────────────────────────────────────────
-- Rules are evaluated against booking_questions answers:
--   [{ question_id, operator, value }]  -> tripping any rule disqualifies.
alter table funnels add column if not exists disqualify_rules jsonb not null default '[]'::jsonb;
alter table funnels add column if not exists disqualify_redirect_url text;

-- disqualify_action was ('block','flag') from migration 012 — neither of which is
-- what the gate needs. Widen to the render states the not-a-fit screen supports,
-- keeping the old values so existing rows stay valid.
alter table funnels drop constraint if exists funnels_disqualify_action_check;
alter table funnels add constraint funnels_disqualify_action_check
  check (disqualify_action in ('block', 'flag', 'message', 'resource', 'redirect', 'ai_assistant'));

-- ── 4. Funnel event vocabulary ──────────────────────────────────────────────
-- Adds the application-gate events and the sell-mode offer click. DROP + re-ADD
-- over the CURRENT set (053, which already allows 'sold'), the same pattern
-- 042/044/047/048/053 used — every existing value is carried forward.
alter table funnel_events drop constraint if exists funnel_events_event_type_check;
alter table funnel_events add constraint funnel_events_event_type_check
  check (event_type = any (array[
    'landing_view', 'training_view', 'signup', 'booking_click', 'booked', 'closed',
    'video_watched', 'video_completed', 'email_opened', 'email_clicked',
    -- application gate
    'application_started', 'application_submitted', 'qualified', 'disqualified',
    -- sell mode
    'offer_click', 'sold'
  ]));

-- Where a lead's application answers live. A DISQUALIFIED lead never becomes a
-- booking, so bookings.custom_answers cannot be the record for them — without
-- this the answers of everyone the gate turned away would be discarded, and the
-- coach could never see who they rejected or why.
alter table funnel_leads add column if not exists application_answers jsonb;
alter table funnel_leads add column if not exists application_status text;
alter table funnel_leads drop constraint if exists funnel_leads_application_status_check;
alter table funnel_leads add constraint funnel_leads_application_status_check
  check (application_status is null or application_status in ('applied', 'qualified', 'disqualified'));
alter table funnel_leads add column if not exists application_submitted_at timestamptz;

-- ── 5. Post-call attendance ─────────────────────────────────────────────────
-- Drives the post-call follow-up: the 3 emails schedule on 'showed' and must
-- never send on 'no_show'. NULL = not yet marked.
alter table bookings add column if not exists attended text;
alter table bookings drop constraint if exists bookings_attended_check;
alter table bookings add constraint bookings_attended_check
  check (attended is null or attended in ('showed', 'no_show'));
alter table bookings add column if not exists attendance_marked_at timestamptz;

comment on column funnels.disqualify_rules is
  'Application-gate rules: [{question_id, operator, value}]. Any rule that trips disqualifies the lead.';
comment on column funnels.cta_mode is
  'book = training CTA opens the booking calendar; sell = training CTA goes to offer_url and no calendar renders.';
comment on column bookings.attended is
  'showed | no_show, set via POST /api/bookings/[id]/attendance. NULL until marked. Post-call emails send only on showed.';
