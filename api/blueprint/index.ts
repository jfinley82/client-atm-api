import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  if (req.method !== 'GET') return res.status(405).end()

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const [outputsResult, quizResult, userResult] = await Promise.all([
      supabase
        .from('saved_outputs')
        .select('tool_type, content, created_at')
        .eq('user_id', payload.userId),
      supabase
        .from('quiz_responses')
        .select('score, analysis')
        .eq('user_id', payload.userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
      supabase
        .from('users')
        .select('name, email, has_paid')
        .eq('id', payload.userId)
        .single()
    ])

    const outputs = outputsResult.data || []
    const byType = Object.fromEntries(
      outputs.map(o => [o.tool_type, o.content])
    )

    return res.status(200).json({
      user: userResult.data,
      quiz: quizResult.data || null,
      audience: byType['audience'] || null,
      transformation: byType['transformation'] || null,
      monetization: byType['monetization'] || null,
      completed_tools: outputs.map(o => o.tool_type)
    })

  } catch (err) {
    console.error('[blueprint]', err)
    return res.status(500).json({ error: 'Failed to load blueprint' })
  }
}
