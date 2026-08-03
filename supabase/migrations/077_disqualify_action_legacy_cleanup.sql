-- One-time cleanup: fold the two legacy disqualify_action values into 'message'.
--
-- DISQUALIFY_ACTIONS (lib/applicationGate.ts) still accepts 'block' and 'flag'
-- so existing rows keep validating, but nothing offers them any more: the
-- settings drawer lists message | resource | redirect | ai_assistant, and it
-- already DISPLAYS a legacy row as "Show a message". This makes the stored data
-- agree with what the coach is being shown, so a save that touches any other
-- field doesn't silently rewrite the destination underneath them.
--
-- 'message' is the correct target, not a guess: both legacy values rendered the
-- not-a-fit message at the gate, so behaviour is unchanged by this update.
--
-- Idempotent — re-running matches nothing.
update funnels
   set disqualify_action = 'message'
 where disqualify_action in ('block', 'flag');
