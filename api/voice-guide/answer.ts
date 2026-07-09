import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { continueInterview, QaEntry } from '../../lib/voiceGuide'
import { GenerationParseError } from '../../lib/aiJson'

// Appends the answer to the last (unanswered) qa_log entry, reconstructs the
// full message history from qa_log, and continues the interview. On
// type:"question" persists the new question; on type:"complete" saves the
// guide and marks the row complete.
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
  const { answer } = body
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    return res.status(400).json({ error: 'answer (non-empty string) required' })
  }

  try {
    const { data: row, error: fetchErr } = await supabase
      .from('voice_guides')
      .select('qa_log')
      .eq('user_id', userId)
      .maybeSingle()
    if (fetchErr) throw fetchErr
    if (!row || !Array.isArray(row.qa_log) || row.qa_log.length === 0) {
      return res.status(400).json({ error: 'No interview in progress — call /start first' })
    }

    const qaLog = row.qa_log as QaEntry[]
    const updatedLog: QaEntry[] = qaLog.map((entry, i) => (i === qaLog.length - 1 ? { ...entry, answer } : entry))

    const turn = await continueInterview(userId, updatedLog)

    if (turn.type === 'complete') {
      const { error } = await supabase
        .from('voice_guides')
        .update({ status: 'complete', qa_log: updatedLog, guide_md: turn.text, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
      if (error) throw error
      return res.status(200).json({ status: 'complete', guide: turn.text })
    }

    const newLog: QaEntry[] = [
      ...updatedLog,
      { category: turn.category, question: turn.text, answer: null, progress: turn.progress },
    ]
    const { error } = await supabase
      .from('voice_guides')
      .update({ qa_log: newLog, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    if (error) throw error

    return res.status(200).json({ status: 'in_progress', qaLog: newLog })
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[voice-guide/answer] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[voice-guide/answer] POST', err)
    return res.status(500).json({ error: 'Failed to process answer' })
  }
}
