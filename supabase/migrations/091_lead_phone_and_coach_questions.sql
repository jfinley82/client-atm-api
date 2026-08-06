-- The lead's phone number, and the coach's own booking-form configuration.

-- LEAD_PHONE, not phone. funnel_business_settings.phone already exists and is
-- the COACH's number. Two columns called `phone` with opposite owners is how the
-- wrong one ends up in a notification email addressed to the person it belongs
-- to, so the ambiguity is removed at the column rather than managed at each call
-- site.
--
-- NULLABLE, and it stays nullable however the required toggle is set.
-- Requiredness is a FORM rule, not a storage rule: six bookings already exist
-- without one, and any coach can turn the toggle off tomorrow. A NOT NULL
-- backfilled with '' would be a lie about those six and a trap for the seventh.
alter table bookings add column if not exists lead_phone text;

comment on column bookings.lead_phone is
  'The LEAD''s phone number, captured on the booking form. NULL when not supplied or not asked for. Not to be confused with funnel_business_settings.phone, which is the coach''s.';

-- Per-coach booking questions, mirroring funnels.booking_questions: same
-- BookingQuestion shape, same normalizeBookingQuestions validator, same four
-- types, because the frontend reuses the admin editor and a second shape would
-- break it.
--
-- No application_questions_enabled twin here. A funnel needs that flag because
-- its questions gate an application; a coach's booking page has no gate, so an
-- empty array already means "ask nothing" without a second switch that could
-- disagree with it.
alter table funnel_business_settings
  add column if not exists booking_questions jsonb,
  add column if not exists booking_phone_required boolean not null default true;

comment on column funnel_business_settings.booking_questions is
  'The coach''s own booking-page questions, same shape as funnels.booking_questions. NULL or [] means name, email and phone only - never a fallback to the global MTM set.';
comment on column funnel_business_settings.booking_phone_required is
  'Whether this coach''s booking forms require the lead''s phone. Default true: the field exists because a coach needs the number, so losing the booking instead is a deliberate choice.';
