import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { callClaude, AUDIENCE_PROMPT } from '../../lib/llm'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  // GET — return saved output
  if (req.method === 'GET') {
    const { data } = await supabase
      .from('saved_outputs')
      .select('*')
      .eq('user_id', payload.userId)
      .eq('tool_type', 'audience')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    return res.status(200).json({ output: data?.content || null })
  }

  if (req.method !== 'POST') return res.status(405).end()

  const { niche, who_you_help, their_problem, your_solution, current_clients } = req.body || {}

  if (!niche || !who_you_help) {
    return res.status(400).json({ error: 'niche and who_you_help are required' })
  }

  try {
    const userMessage = `
Niche/Industry: ${niche}
Who I help: ${who_you_help}
Their main problem: ${their_problem || 'not specified'}
My solution/approach: ${your_solution || 'not specified'}
Current clients description: ${current_clients || 'not specified'}
    `.trim()

    const result = await callClaude(AUDIENCE_PROMPT, userMessage)

    // Save output
    const { error } = await supabase
      .from('saved_outputs')
      .upsert(
        { user_id: payload.userId, tool_type: 'audience', content: result },
        { onConflict: 'user_id,tool_type' }
      )

    if (error) throw error

    return res.status(200).json({ ok: true, result })

  } catch (err) {
    console.error('[tools/audience]', err)
    return res.status(500).json({ error: 'Generation failed' })
  }
}
