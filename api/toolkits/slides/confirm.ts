import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput } from '../../../lib/savedOutputs'
import { SlideEntry, SlidesDeck } from '../../../lib/slidesAnalysis'
import { getValidatedBlueprint } from '../../../lib/toolkitsShared'
import { stampSyncSnapshot } from '../../../lib/syncDependencies'
import { checkSyncGate } from '../../../lib/syncGate'
import { deckSlidesToCanonical, canonicalRowToDeck, frameworkPhaseNames } from '../../../lib/slidesCanonical'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// Accepts the frontend's SlidesDeck shape (still includes key_points), which is
// validated here but not persisted — key_points is retired in the canonical
// model.
function isValidSlide(v: unknown): v is SlideEntry {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (
    typeof s.slide_number === 'number' &&
    isNonEmptyString(s.title) &&
    typeof s.speaker_notes === 'string' &&
    Array.isArray(s.key_points) &&
    s.key_points.every((k) => typeof k === 'string')
  )
}

// Save step for one card's deck. Writes the (possibly edited) deck to the
// canonical mtm_generations row and re-stamps its 'slides' sync snapshot — there
// is no separate confirmed boolean anymore (Build is presence-based). Re-checks
// the card is a validated user-owned blueprint before writing.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Capability gate — save is part of the toolkits capability (beta/full; admin bypasses).
  if (!(await requireCapability(userId, 'toolkits', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { training_title, duration_estimate, slides } = body

  const valid =
    isNonEmptyString(training_title) &&
    typeof duration_estimate === 'string' &&
    Array.isArray(slides) &&
    slides.length >= 10 &&
    slides.length <= 12 &&
    slides.every(isValidSlide)

  if (!valid) {
    return res.status(400).json({
      error:
        'Invalid confirm payload — expects card_id, training_title (non-empty string), duration_estimate (string), and slides (10-12 entries of {slide_number, title, speaker_notes, key_points})',
    })
  }

  try {
    const blueprintGate = await getValidatedBlueprint(userId, body.card_id)
    if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

    const syncGate = await checkSyncGate(userId, 'slides')
    if (!syncGate.ok) {
      return res.status(409).json({ error: 'out_of_sync', blocking: syncGate.blocking, stale_items: syncGate.stale_items })
    }

    const frameworkRow = await getSavedOutput(userId, 'framework')
    const phaseNames = frameworkPhaseNames(frameworkRow?.content)
    const sync_snapshot = await stampSyncSnapshot(userId, 'slides', blueprintGate.card.id)

    const deck: SlidesDeck = {
      training_title: training_title as string,
      duration_estimate: duration_estimate as string,
      slides: slides as SlideEntry[],
      confirmed: true,
    }

    const { data, error } = await supabase
      .from('mtm_generations')
      .upsert(
        {
          user_id: userId,
          card_id: blueprintGate.card.id,
          slides: deckSlidesToCanonical(deck.slides, phaseNames),
          chosen_topic: deck.training_title,
          total_duration: deck.duration_estimate,
          sync_snapshot,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,card_id' }
      )
      .select('slides, chosen_topic, total_duration')
      .single()
    if (error) throw error

    return res.status(200).json(canonicalRowToDeck(data))
  } catch (err) {
    console.error('[toolkits/slides/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
