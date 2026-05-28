import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { callClaude, TRANSFORMATION_PROMPT } from '../../lib/llm'
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
      .eq('tool_type', 'transformation')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    return res.status(200).json({ output: data?.content || null })
  }

  if (req.method !== 'POST') return res.status(405).end()

  const { client_before, client_after, your_method, timeline, your_background } = req.body || {}

  if (!client_before || !client_after) {
    return res.status(400).json({ error: 'client_before and client_after are required' })
  }

  try {
    const userMessage = `
Where my client is BEFORE working with me: ${client_before}
Where my client is AFTER working with me: ${client_after}
How I achieve this (my method/approach): ${your_method || 'not specified'}
Typical timeline to results: ${timeline || 'not specified'}
My background and credibility: ${your_background || 'not specified'}
    `.trim()

    const result = await callClaude(TRANSFORMATION_PROMPT, userMessage)

    const { error } = await supabase
      .from('saved_outputs')
      .upsert(
        { user_id: payload.userId, tool_type: 'transformation', content: result },
        { onConflict: 'user_id,tool_type' }
      )

    if (error) throw error

    return res.status(200).json({ ok: true, result })

  } catch (err) {
    console.error('[tools/transformation]', err)
    return res.status(500).json({ error: 'Generation failed' })
  }
}
