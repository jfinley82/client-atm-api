import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'
import { resolveLeadSession, resolveCardId } from '../../lib/aiCoachSession'

// GET /api/ai-coach/synopsis[?card_id=] — lead-authed. The "sheet" the
// lead-facing AI coach shell reads from.
//
//   { problem, synopsis {6}, transformation {before, after}, close {2} }
//
// problem/synopsis/transformation are the ONE problem this conversation is
// about; close is account-level and the same whichever problem that is.
//
// card_id re-resolves the sheet to another of the coach's problems (how the bot
// pivots a lead mid-conversation). Absent, it is the lead's entry problem.
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

// The WHOLE sheet is sourced from the resolved card's synopsis — one object, so
// every panel is about the same problem and cannot drift between sources.
const SYNOPSIS_FIELDS = [
  'audience_quote',
  'cost_of_inaction',
  'objection_dissolved',
  'teaching_outline',
  'solution_summary',
  'training_title',
] as const

// synopsis.transformation is the PER-CARD before/after, i.e. the transformation
// for THIS problem specifically.
//
// Deliberately not saved_outputs.transformation, which is the account-level one
// (before_state/after_state/before_results/after_results/the_bridge/proof_point,
// all populated on live data). That row describes the coach's business as a
// whole; this describes the problem the lead is actually here about, which is
// what the sheet is for.
const TRANSFORMATION_FIELDS = ['before', 'after'] as const

// The close block IS account-level, from saved_outputs.transformation, and does
// not move when the sheet re-resolves to another card: proof_point is the
// coach's one real result and the_bridge is what made it possible. Both are
// about the coach's practice as a whole, so they are the same in every
// conversation.
//
// Only these two of that row's twelve keys are lead-safe. Deliberately left
// behind: session_history (the raw interview transcript), client_language_*
// and *_internal_talk (a named client's private self-talk), and the four
// before/after_state/results fields, which are the account-level version of the
// per-card transformation above and would contradict it on the same screen.
const CLOSE_FIELDS = ['proof_point', 'the_bridge'] as const

// Never leaves the card's synopsis: high_ticket_pitch and offer_includes are
// sales framing the coach writes for themselves, and framework_fit is internal
// positioning. Field-pinning above is what keeps them out — this list is the
// record of WHY, so a future "just return the whole synopsis" is recognised as
// the leak it would be.
// const EXCLUDED = ['high_ticket_pitch', 'offer_includes', 'framework_fit']

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

  const requestedRaw = req.query.card_id
  const requested = typeof requestedRaw === 'string' ? requestedRaw.trim() : Array.isArray(requestedRaw) ? String(requestedRaw[0] || '').trim() : ''

  try {
    // Every read is scoped to the coach, so a card that is not theirs simply
    // does not resolve — that scoping, not a separate ownership check, is what
    // stops another coach's blueprint reaching a lead.
    const load = (id: string) =>
      supabase
        .from('problem_solution_cards')
        .select('id, card_name, problem_text, synopsis')
        .eq('id', id)
        .eq('user_id', session.coachUserId)
        .maybeSingle()

    // An explicit card_id re-resolves the sheet — this is how the bot pivots a
    // lead to a different problem mid-conversation. Validated against the
    // coach's WHOLE card set rather than the bot's card_ids, since the hosted
    // bot covers all of them.
    //
    // A card_id that is not theirs CLAMPS to the entry problem instead of
    // erroring: the lead did not type it, so a 400 would surface a bug in the
    // bot as a broken sheet in front of them. The response always carries
    // problem.card_id, so the caller can see which card it actually got.
    let card: Record<string, any> | null = null
    if (requested) {
      const { data } = await load(requested)
      card = (data as Record<string, any>) ?? null
    }

    if (!card) {
      const entryCardId = await resolveCardId(session)
      if (!entryCardId) return res.status(404).json({ error: 'not_active' })
      const { data } = await load(entryCardId)
      card = (data as Record<string, any>) ?? null
    }
    if (!card) return res.status(404).json({ error: 'not_active' })

    const synopsis = (card as any).synopsis
    const transformationRow = await getSavedOutput(session.coachUserId, 'transformation')

    return res.status(200).json({
      problem: {
        card_id: (card as any).id,
        card_name: (card as any).card_name ?? null,
        problem_text: (card as any).problem_text ?? null,
      },
      synopsis: pick(synopsis, SYNOPSIS_FIELDS),
      transformation: pick(
        synopsis && typeof synopsis === 'object' ? (synopsis as Record<string, unknown>).transformation : null,
        TRANSFORMATION_FIELDS
      ),
      close: pick(transformationRow?.content, CLOSE_FIELDS),
    })
  } catch (err) {
    console.error('[ai-coach/synopsis] GET', err)
    return res.status(500).json({ error: 'Failed to load synopsis' })
  }
}
