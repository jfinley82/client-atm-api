import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { normalizeProblemStatement, scoreQuiz, validateQuizAnswers } from '../../lib/quizScoring'

// POST /api/quiz/analyze — authenticated. The whole quiz submission: seven
// letters plus the open problem question.
//
// Body: { answers: { client_flow: 'a', … }, problem_statement?: string }
//
// Scores, persists, and stamps users.quiz_completed / quiz_score — ALL SERVER
// SIDE, and all in one transaction. The old app set the completion flag from
// the browser and never sent a score anywhere, which is why the test account
// reads quiz_completed=true with quiz_score=null: a completion nothing can
// stand behind. Nothing about completion is accepted from the client here, not
// even as a hint.
//
// The scoring itself lives in lib/quizScoring.ts and is pure. This handler
// decides nothing about numbers — it validates, calls, and writes.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const body = (req.body || {}) as Record<string, unknown>

  const checked = validateQuizAnswers(body.answers)
  if (!checked.ok) {
    return res.status(400).json({ error: checked.error, message: checked.message })
  }

  // Verbatim, and deliberately not validated beyond being a string. There is no
  // length cap, no profanity pass and no punctuation fix: this is the coach's
  // own sentence, offered back to them in Step 1 as their own words.
  const problemStatement = normalizeProblemStatement(body.problem_statement)

  try {
    const analysis = scoreQuiz(checked.answers)

    // ONE CALL, ONE TRANSACTION. The insert and the users stamp cannot separate
    // — see migration 092. quiz_score is taken from the inserted row inside the
    // function rather than passed again, so the two cannot disagree.
    const { data, error } = await supabase.rpc('record_quiz_result', {
      p_user_id: userId,
      p_answers: checked.answers,
      p_problem_statement: problemStatement,
      p_score: analysis.composite,
      p_analysis: analysis,
    })
    if (error) throw error

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
    if (!row) throw new Error('record_quiz_result returned no row')

    return res.status(200).json({
      id: row.id,
      answers: checked.answers,
      problem_statement: problemStatement,
      score: analysis.composite,
      analysis,
      // Echoed from what the server just wrote, so the client has no reason to
      // hold a completion flag of its own.
      quiz_completed: true,
      created_at: row.created_at,
    })
  } catch (err) {
    console.error('[quiz/analyze] POST', err)
    return res.status(500).json({ error: 'Failed to analyze quiz' })
  }
}
