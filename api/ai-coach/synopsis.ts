import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'
import { resolveLeadSession, resolveCardId } from '../../lib/aiCoachSession'

// GET /api/ai-coach/synopsis — lead-authed. The "sheet" the lead-facing AI coach
// shell reads from: the ONE problem this conversation is about, its pre-built
// synopsis, and the coach's transformation.
//
// READ-ONLY BY CONTRACT. Every field here was authored earlier by the coach in
// Steps 1-3 and confirmed by them; nothing is generated, and there is no model
// call on this path. If a field is missing it comes back null rather than being
// invented — a lead reading a synopsis the coach never wrote would be worse than
// a shorter one.
//
// The frontend reveals progressively (before -> after -> full); the whole
// payload ships at once so the reveal costs no extra round trips.
export const config = { maxDuration: 30 }

// From problem_solution_cards.synopsis — the six the sheet renders.
const SYNOPSIS_FIELDS = [
  'audience_quote',
  'cost_of_inaction',
  'objection_dissolved',
  'teaching_outline',
  'solution_summary',
  'training_title',
] as const

// From saved_outputs.transformation (account-level, not per-card).
const TRANSFORMATION_FIELDS = [
  'before_state',
  'after_state',
  'before_results',
  'after_results',
  'the_bridge',
  'proof_point',
] as const

function pick<T extends readonly string[]>(src: unknown, keys: T): Record<string, unknown> {
  const o = (src && typeof src === 'object' && !Array.isArray(src) ? src : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = o[k] ?? null
  return out
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const gate = await resolveLeadSession(req)
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error })
  const { session } = gate

  try {
    const cardId = await resolveCardId(session)
    if (!cardId) return res.status(404).json({ error: 'not_active' })

    // Scoped to the coach: a card_id in their own config should always be
    // theirs, but reading it back under user_id means a stale or edited config
    // can never surface another coach's blueprint to a lead.
    const { data: card } = await supabase
      .from('problem_solution_cards')
      .select('id, card_name, problem_text, synopsis')
      .eq('id', cardId)
      .eq('user_id', session.coachUserId)
      .maybeSingle()
    if (!card) return res.status(404).json({ error: 'not_active' })

    const transformationRow = await getSavedOutput(session.coachUserId, 'transformation')

    return res.status(200).json({
      problem: {
        card_id: (card as any).id,
        card_name: (card as any).card_name ?? null,
        problem_text: (card as any).problem_text ?? null,
      },
      synopsis: pick((card as any).synopsis, SYNOPSIS_FIELDS),
      transformation: pick(transformationRow?.content, TRANSFORMATION_FIELDS),
    })
  } catch (err) {
    console.error('[ai-coach/synopsis] GET', err)
    return res.status(500).json({ error: 'Failed to load synopsis' })
  }
}
