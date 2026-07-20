-- Make matcher/finalize idempotent: finalize REPLACES the user's validated
-- blueprint set instead of appending to it.
--
-- Previously POST /api/matcher/finalize inserted 3 new validated cards without
-- removing the prior ones, so a coach who finalized more than once accumulated
-- 6, 9, 12+ validated problem_solution_cards. That broke the downstream
-- "exactly 3 validated blueprints" gate (core_offers / program), which then
-- failed with blueprints_incomplete — surfaced as a misleading save error.
--
-- finalize_blueprints deletes the caller's existing validated=true rows and
-- inserts the fresh batch in ONE transaction (a single function call is
-- atomic), so a failed insert rolls back the delete — a user is never left with
-- 0 validated cards. Only the caller's own validated=true rows are removed;
-- draft / non-validated rows and every other user's rows are untouched.
--
-- Returns the inserted rows (setof the table) so the endpoint's response shape
-- is identical to the previous insert(...).select().

create or replace function finalize_blueprints(
  p_user_id uuid,
  p_cards jsonb,
  p_sync_snapshot jsonb
)
returns setof problem_solution_cards
language plpgsql
set search_path = public
as $$
begin
  delete from problem_solution_cards
  where user_id = p_user_id and validated = true;

  return query
  insert into problem_solution_cards (
    user_id,
    card_name,
    problem_text,
    reasoning,
    suggested_offer,
    source_problem_id,
    validated,
    sync_snapshot
  )
  select
    p_user_id,
    elem->>'card_name',
    elem->>'problem_text',
    elem->>'reasoning',
    -- absent key -> SQL NULL; explicit JSON null -> SQL NULL; otherwise the
    -- suggested_offer object is stored as-is (matches c.suggested_offer ?? null).
    case
      when elem->'suggested_offer' is null or elem->'suggested_offer' = 'null'::jsonb
      then null
      else elem->'suggested_offer'
    end,
    elem->>'source_problem_id',
    true,
    p_sync_snapshot
  from jsonb_array_elements(p_cards) as elem
  returning *;
end;
$$;
