-- Widen mtm_generations for the Micro-Training payoff (Step 4 Build / Step 5
-- Launch). The canonical per-(user_id, card_id) store gains the assets the
-- unified generator produces, plus updated_at and a uniqueness guarantee so the
-- generator can UPSERT on (user_id, card_id) instead of appending rows.
--
-- Column payload shapes (documented here; the columns are plain jsonb/text):
--   slides           : flat array of
--                      { slideNumber, slideTitle, script, speakerNote, timing, sectionName }
--   workbook         : { title, intro,
--                        sections: [{ sectionTitle, keyInsight,
--                                     exercises: [{ prompt, lines }], reflection }],
--                        keyTakeaways: string[] }
--   facilitator_tips : [{ category, tip }]
--   delivery         : the coach's Step 4 delivery inputs
--                      { duration, format, facilitator_name, soft_cta?, call_page_url? }
--   subtitle         : the training subtitle
--   total_duration   : human-readable total run time (e.g. "90 minutes")

alter table mtm_generations add column if not exists subtitle text;
alter table mtm_generations add column if not exists total_duration text;
alter table mtm_generations add column if not exists workbook jsonb;
alter table mtm_generations add column if not exists facilitator_tips jsonb;
alter table mtm_generations add column if not exists delivery jsonb;
alter table mtm_generations add column if not exists updated_at timestamptz default now();

-- One canonical row per (user_id, card_id) so POST /api/generate can UPSERT.
-- Verified beforehand that no duplicate (user_id, card_id) groups exist, so this
-- adds cleanly without touching any data.
alter table mtm_generations
  add constraint mtm_generations_user_card_uniq unique (user_id, card_id);
