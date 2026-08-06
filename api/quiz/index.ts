import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'

// GET /api/quiz — authenticated. The coach's most recent quiz result, or 404.
//
// WITHOUT THIS THE QUIZ IS WRITE-ONLY. The results screen has nothing to
// re-read on a refresh, and Step 1 — which opens by offering the coach their own
// problem statement back — has nothing to open with. It is the whole handoff.
//
// 404 rather than 200-with-nulls when there is no result. "Never taken it" is a
// different state from "took it and scored zero", and a caller that has to
// inspect fields to tell them apart will eventually get it wrong on the branch
// that matters. Step 1's no-quiz path is not a fallback bolted on later — it is
// what every coach who skips the quiz gets — so it deserves a status code it can
// branch on directly.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    // MOST RECENT, not "the one" — retaking is allowed and every attempt is
    // kept. Ordered by created_at desc with a limit rather than assuming one row
    // per coach, because nothing in the schema enforces that and a silent
    // "whichever came back first" would be a different result on different days.
    const { data, error } = await supabase
      .from('quiz_responses')
      .select('id, answers, problem_statement, score, analysis, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'not_found' })

    const row = data as Record<string, unknown>
    return res.status(200).json({
      id: row.id,
      answers: row.answers,
      // Normalised to a string for the caller: the column is nullable because
      // "never taken" and "answered with nothing" are different facts, but by
      // the time a row exists the distinction Step 1 cares about is only whether
      // there are words to offer back.
      problem_statement: typeof row.problem_statement === 'string' ? row.problem_statement : '',
      score: row.score,
      analysis: row.analysis,
      created_at: row.created_at,
    })
  } catch (err) {
    console.error('[quiz] GET', err)
    return res.status(500).json({ error: 'Failed to load quiz result' })
  }
}
