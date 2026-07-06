import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../lib/savedOutputs'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const rawType = req.query && req.query.tool_type
  const toolType = Array.isArray(rawType) ? rawType[0] : rawType

  // With tool_type — return the single saved output for that user + tool_type.
  // content has the transcript stripped so this endpoint keeps returning the
  // profile shape (and doesn't ship a large session_history payload).
  if (toolType && typeof toolType === 'string') {
    try {
      const data = await getSavedOutput(userId, toolType)
      return res.status(200).json(data ? { ...data, content: stripSessionHistory(data.content) } : null)
    } catch (err) {
      console.error('[tools/saved] GET one', err)
      return res.status(500).json({ error: 'Failed to load saved output' })
    }
  }

  // No tool_type — return all saved outputs for the user (transcript stripped
  // from each, same as the single-row branch).
  try {
    const { data, error } = await supabase
      .from('saved_outputs')
      .select('tool_type, content, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error
    return res.status(200).json((data || []).map((row: any) => ({ ...row, content: stripSessionHistory(row.content) })))
  } catch (err) {
    console.error('[tools/saved] GET all', err)
    return res.status(500).json({ error: 'Failed to load saved outputs' })
  }
}
