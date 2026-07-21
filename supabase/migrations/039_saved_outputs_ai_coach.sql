-- Standalone account-level AI Coach: a single AI assistant persona the coach
-- configures and deploys on their own ChatGPT/Claude. Persisted as a
-- saved_outputs row, tool_type 'ai_coach' (one per user). Add it to the
-- tool_type CHECK constraint's allowed values (DROP + re-ADD with the full list).
alter table saved_outputs drop constraint if exists saved_outputs_tool_type_check;
alter table saved_outputs add constraint saved_outputs_tool_type_check
  check (tool_type = any (array[
    'audience','transformation','matcher','matcher_intake','matcher_analysis',
    'transformation_analysis','framework','core_offers','program','content',
    'slides','qualifier','build_selection','ai_coach'
  ]));
