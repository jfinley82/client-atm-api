import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase.js'
import { callClaude, QUIZ_PROMPT } from '../../lib/llm.js'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  // Auth required
  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  const { answers } = req.body || {}
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'Answers object required' })
  }

  try {
    const userMessage = `Here are the quiz responses from a coach/consultant:\n\n${
      Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n')
    }`

    const analysis = await callClaude(QUIZ_PROMPT, userMessage) as any

    // Save to DB
    const { error } = await supabase
      .from('quiz_responses')
      .upsert(
        {
          user_id: payload.userId,
          answers,
          score: analysis.overall_score,
          analysis
        },
        { onConflict: 'user_id' }
      )

    if (error) throw error

    // Update user quiz_completed and score
    await supabase
      .from('users')
      .update({ quiz_completed: true, quiz_score: analysis.overall_score })
      .eq('id', payload.userId)

    return res.status(200).json({ ok: true, analysis })

  } catch (err) {
    console.error('[quiz/analyze]', err)
    return res.status(500).json({ error: 'Analysis failed' })
  }
}
