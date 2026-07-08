import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { SlideEntry, SlidesDeck } from '../../../lib/slidesAnalysis'
import { getValidatedBlueprint, saveByCardIdEntry } from '../../../lib/toolkitsShared'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

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

// Explicit buy-in step for one card_id's deck. Body carries card_id plus the
// full (possibly edited) deck. Re-verifies the card is still a validated
// blueprint belonging to this user (same check as analyze) before writing —
// never trust a client-supplied card_id blindly. Sets confirmed: true.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

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

    const updated: SlidesDeck = {
      training_title,
      duration_estimate,
      slides: slides as SlideEntry[],
      confirmed: true,
    }

    const saved = await saveByCardIdEntry(userId, 'slides', blueprintGate.card.id, updated)

    return res.status(200).json(saved.by_card_id[blueprintGate.card.id])
  } catch (err) {
    console.error('[toolkits/slides/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
