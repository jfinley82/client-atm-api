-- Who authored the current chosen_angle: 'ai' when the meta unit generated it on
-- a fresh generate (or the coach picked one of the AI-suggested titles), 'coach'
-- when the coach wrote or edited their own hook (a custom title reword, or an
-- inline angle edit). A coach-authored hook is excluded from the banned-shape
-- auto-repair so it is never silently rewritten. Existing rows default to 'ai'
-- (their angles were all AI-generated).
alter table mtm_generations add column if not exists angle_source text not null default 'ai';
