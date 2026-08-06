-- The ATM Quiz: the open problem question, and one atomic write for a result.
--
-- 1. quiz_responses.problem_statement
--
-- The quiz gains one open question — "in your own words, what problem do you
-- help people solve?" — stored verbatim and never scored.
--
-- A COLUMN RATHER THAN A KEY IN `answers`. Step 1 reads this to open with the
-- coach's own sentence, so it is a thing somebody queries, inspects and
-- migrates. Buried in the answers jsonb it would be one normalizer away from
-- being reshaped by a change that had nothing to do with it, and the reshaping
-- would be invisible until a coach saw their own words come back altered.
--
-- Nullable with no default: never taken and answered-with-nothing are different
-- facts, and the read side already distinguishes them.
alter table quiz_responses add column if not exists problem_statement text;

-- 2. record_quiz_result
--
-- WHY A FUNCTION RATHER THAN TWO CALLS FROM THE HANDLER. The result has to land
-- in quiz_responses AND stamp users.quiz_completed / quiz_score together. Done
-- as two REST calls, a failure between them leaves exactly the state this whole
-- change exists to fix: the account marked complete with no score behind it,
-- which is what workwithjamaul@gmail.com reads as today (quiz_completed true,
-- quiz_score null) because the old frontend set the flag from the browser.
--
-- A single function call is one transaction, so the write and the stamp succeed
-- together or neither happens. There is no ordering of two REST calls that gets
-- this property.
--
-- WHY UPSERT AND NOT INSERT. quiz_responses carries a UNIQUE constraint on
-- user_id (quiz_responses_user_id_key) — ONE ROW PER COACH, already, since
-- before this change. A plain insert works perfectly on a first submission and
-- throws 23505 on every retake, which no amount of local testing reveals
-- because the mocked table has no constraints. Found by running this function
-- against production inside begin/rollback, which is the only reason it is an
-- upsert here rather than a 500 the first time a coach retook the quiz.
--
-- So a retake REPLACES the row. Nothing accumulates, and there is exactly one
-- result per coach at all times — which is also what makes the read side's
-- "most recent" unambiguous rather than a race.
--
-- quiz_score is set FROM the written row's score rather than from a second
-- parameter, so the two cannot be passed different numbers. Acceptance item 2
-- checks they match; this makes disagreeing impossible rather than tested.
create or replace function record_quiz_result(
  p_user_id uuid,
  p_answers jsonb,
  p_problem_statement text,
  p_score integer,
  p_analysis jsonb
)
returns quiz_responses
language plpgsql
set search_path = public
as $$
declare
  v_row quiz_responses;
begin
  insert into quiz_responses (user_id, answers, problem_statement, score, analysis)
  values (p_user_id, p_answers, p_problem_statement, p_score, p_analysis)
  on conflict (user_id) do update
    set answers           = excluded.answers,
        problem_statement = excluded.problem_statement,
        score             = excluded.score,
        analysis          = excluded.analysis,
        updated_at        = now()
  returning * into v_row;

  update users
     set quiz_completed = true,
         quiz_score = v_row.score
   where id = p_user_id;

  return v_row;
end;
$$;
