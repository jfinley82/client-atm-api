-- The application gate's canonical model is the jsonb path on `funnels`:
-- booking_questions (array) + application_questions_enabled + disqualify_rules,
-- read by lib/applicationGate.ts and lib/bookingQuestions.ts, and answers stored
-- on funnel_leads.application_answers/application_status/application_submitted_at
-- (see api/funnel/application.ts). That is what every live code path — the
-- gate, the Forms tab stats (prompt 02), the render — actually reads and writes.
--
-- funnel_application_questions / funnel_application_options / funnel_lead_answers
-- were a normalized alternative that never got wired to anything: confirmed zero
-- rows in every environment and zero references anywhere in api/ or lib/ before
-- writing this migration. Dropped rather than left as a note, so the Forms
-- editor (or any future code) has no dead tables to accidentally target instead
-- of funnels.booking_questions — same "if it's confirmed dead, remove it, don't
-- just document it" call as migration 067's per-funnel brand/legal column drop.
--
-- Children before parents: funnel_lead_answers references both
-- funnel_application_questions and funnel_application_options;
-- funnel_application_options references funnel_application_questions.
drop table if exists funnel_lead_answers;
drop table if exists funnel_application_options;
drop table if exists funnel_application_questions;
