import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { callClaude, MONETIZATION_PROMPT } from '../../lib/llm'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin as string || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  if (req.method === 'GET') {
    const { data } = await supabase
      .from('saved_outputs')
      .select('*')
      .eq('user_id', payload.userId)
      .eq('tool_type', 'monetization')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    return res.status(200).json({ output: data?.content || null })
  }

  if (req.method !== 'POST') return res.status(405).end()

  const { niche, transformation_summary, current_price, revenue_goal, delivery_preference } = req.body || {}

  if (!niche) return res.status(400).json({ error: 'niche is required' })

  try {
    const userMessage = `
My niche/who I serve: ${niche}
My core transformation: ${transformation_summary || 'not specified'}
What I currently charge (if anything): ${current_price || 'not specified'}
Monthly revenue goal: ${revenue_goal || 'not specified'}
How I prefer to deliver (1:1, group, self-paced, etc.): ${delivery_preference || 'not specified'}
    `.trim()

    const result = await callClaude(MONETIZATION_PROMPT, userMessage)

    const { error } = await supabase
      .from('saved_outputs')
      .upsert(
        { user_id: payload.userId, tool_type: 'monetization', content: result },
        { onConflict: 'user_id,tool_type' }
      )

    if (error) throw error

    return res.status(200).json({ ok: true, result })

  } catch (err) {
    console.error('[tools/monetization]', err)
    return res.status(500).json({ error: 'Generation failed' })
  }
}
