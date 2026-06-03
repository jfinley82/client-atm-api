import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { chatWithClaude, CHAT_SYSTEM_PROMPT, ChatTurn } from '../../lib/llm'
import { getSessionFromRequest, verifySessionToken } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// How many prior turns to load for context on each request.
const HISTORY_LIMIT = 20

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const sessionToken = getSessionFromRequest(req as any)
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' })
  const payload = await verifySessionToken(sessionToken)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })

  // GET — return recent chat history (oldest first)
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('role, content, created_at')
        .eq('user_id', payload.userId)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT)

      if (error) throw error

      const messages = (data || []).reverse()
      return res.status(200).json({ messages })
    } catch (err) {
      console.error('[tools/chat] GET', err)
      return res.status(500).json({ error: 'Failed to load chat history' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  const { message } = req.body || {}

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' })
  }
  if (message.length > 4000) {
    return res.status(400).json({ error: 'message is too long' })
  }

  try {
    // Load recent history to give the model conversational context.
    const { data: prior } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('user_id', payload.userId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)

    const history: ChatTurn[] = (prior || [])
      .reverse()
      .map(m => ({ role: m.role as ChatTurn['role'], content: m.content }))

    history.push({ role: 'user', content: message })

    const reply = await chatWithClaude(CHAT_SYSTEM_PROMPT, history)

    // Persist both the user's message and the assistant's reply.
    const { error } = await supabase.from('chat_messages').insert([
      { user_id: payload.userId, role: 'user', content: message },
      { user_id: payload.userId, role: 'assistant', content: reply },
    ])

    if (error) throw error

    return res.status(200).json({ ok: true, reply })
  } catch (err) {
    console.error('[tools/chat] POST', err)
    return res.status(500).json({ error: 'Chat failed' })
  }
}
