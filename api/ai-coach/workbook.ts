import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { resolveLeadSession } from '../../lib/aiCoachSession'

// GET /api/ai-coach/workbook — lead-authed. The guide as readable prose for the
// shell's workbook panel; profile's actions.guide_url is the rendered PDF and
// nothing else, so this is the prose's only lead-authed source.
//
// NO FIELD-PINNING, and deliberately so rather than reflexively copying
// synopsis.ts's discipline: this exact object is already rendered to a PDF and
// handed to leads through the nurture emails — it is lead-facing by
// construction. The shape is MtWorkbook (lib/microTrainingGenerator.ts).
//
// closing_invite carries BOTH CTA variants (book_call and sell_program); both
// are returned and the frontend picks by the coach's goal, the same way the
// funnel pages do.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const result = await resolveLeadSession(req)
  if (!result.ok) return res.status(result.status).json({ error: result.error })
  const session = result.session

  try {
    const generationId = session.funnel.generation_id
    if (typeof generationId !== 'string' || !generationId) {
      // A missing workbook is not a broken session — the panel falls back to
      // the PDF link alone.
      return res.status(200).json({ workbook: null })
    }

    const { data: gen, error } = await supabase
      .from('mtm_generations')
      .select('workbook')
      .eq('id', generationId)
      .eq('user_id', session.coachUserId)
      .maybeSingle()
    if (error) throw error

    const workbook = gen && gen.workbook && typeof gen.workbook === 'object' ? gen.workbook : null
    return res.status(200).json({ workbook })
  } catch (err) {
    console.error('[ai-coach/workbook] GET', err)
    return res.status(500).json({ error: 'workbook_failed' })
  }
}
