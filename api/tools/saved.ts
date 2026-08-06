import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../lib/savedOutputs'
import { audienceForDisplay } from '../../lib/audienceDisplay'

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
      // Audience rows get the same read-time derivation as the dedicated GET,
      // so a panel reading through this endpoint cannot see a different profile
      // shape than one reading through the other. Only audience has a display
      // subset; every other tool_type passes through untouched.
      const stripped = data ? { ...data, content: stripSessionHistory(data.content) } : null
      return res.status(200).json(
        stripped && toolType === 'audience' ? { ...stripped, content: audienceForDisplay(stripped.content, userId) } : stripped
      )
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
    return res.status(200).json(
      (data || []).map((row: any) => {
        const content = stripSessionHistory(row.content)
        return { ...row, content: row.tool_type === 'audience' ? audienceForDisplay(content, userId) : content }
      })
    )
  } catch (err) {
    console.error('[tools/saved] GET all', err)
    return res.status(500).json({ error: 'Failed to load saved outputs' })
  }
}
