-- Step 4 (Build) gate: a coach selects ONE blueprint on the review screen before
-- Build unlocks. The selection is persisted as a saved_outputs row with
-- tool_type 'build_selection' (content { card_id, selected_at }). Add it to the
-- tool_type CHECK constraint's allowed values.
alter table saved_outputs drop constraint if exists saved_outputs_tool_type_check;
alter table saved_outputs add constraint saved_outputs_tool_type_check
  check (tool_type = any (array[
    'audience','transformation','matcher','matcher_intake','matcher_analysis',
    'transformation_analysis','framework','core_offers','program','content',
    'slides','qualifier','build_selection'
  ]));
