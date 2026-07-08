import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { startInterview, QaEntry } from '../../lib/voiceGuide'
import { GenerationParseError } from '../../lib/aiJson'

// Resets/creates the voice_guides row for this user and kicks off a fresh
// interview — including the writing/talking samples in the opening turn if
// provided. Stores the first question and sets status to in_progress.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Tier gate — AI generation requires a paid membership tier
  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const writingSample = typeof body.writingSample === 'string' ? body.writingSample : undefined
  const talkingSample = typeof body.talkingSample === 'string' ? body.talkingSample : undefined

  try {
    const turn = await startInterview(writingSample, talkingSample)
    if (turn.type !== 'question') {
      console.error('[voice-guide/start] model returned type:"complete" on the opening turn')
      return res.status(502).json({ error: 'Interview failed to start' })
    }

    const qaLog: QaEntry[] = [
      { category: turn.category, question: turn.text, answer: null, progress: turn.progress },
    ]

    const { error } = await supabase
      .from('voice_guides')
      .upsert(
        { user_id: userId, status: 'in_progress', qa_log: qaLog, guide_md: null, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
    if (error) throw error

    return res.status(200).json({ status: 'in_progress', qaLog })
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[voice-guide/start] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[voice-guide/start] POST', err)
    return res.status(500).json({ error: 'Failed to start interview' })
  }
}
