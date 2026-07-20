-- The Micro-Training is a single 15-20 minute RECORDED teaching video, not a
-- live workshop. facilitator_tips (migration 035) is reframed as recording tips
-- for the coach on camera (pacing, energy, setup) — rename the column to match.
-- Shape is unchanged: [{ category, tip }].
alter table mtm_generations rename column facilitator_tips to recording_tips;
