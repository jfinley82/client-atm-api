import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'

// GET: current voice guide state for this user (for resuming or display).
// PATCH: lets a coach manually edit their saved guide_md once it's complete.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    noStore(res)
    try {
      const { data, error } = await supabase
        .from('voice_guides')
        .select('status, qa_log, guide_md')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw error
      return res.status(200).json({
        status: data?.status ?? 'not_started',
        qaLog: data?.qa_log ?? [],
        guide: data?.guide_md ?? null,
      })
    } catch (err) {
      console.error('[voice-guide] GET', err)
      return res.status(500).json({ error: 'Failed to load voice guide' })
    }
  }

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const { guide } = body
    if (typeof guide !== 'string' || guide.trim().length === 0) {
      return res.status(400).json({ error: 'guide (non-empty string) required' })
    }

    try {
      const { data: existing, error: fetchErr } = await supabase
        .from('voice_guides')
        .select('status')
        .eq('user_id', userId)
        .maybeSingle()
      if (fetchErr) throw fetchErr
      if (!existing || existing.status !== 'complete') {
        return res.status(400).json({ error: 'voice_guide_not_complete' })
      }

      const { error } = await supabase
        .from('voice_guides')
        .update({ guide_md: guide, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
      if (error) throw error

      return res.status(200).json({ status: 'complete', guide })
    } catch (err) {
      console.error('[voice-guide] PATCH', err)
      return res.status(500).json({ error: 'Failed to update voice guide' })
    }
  }

  return res.status(405).end()
}
