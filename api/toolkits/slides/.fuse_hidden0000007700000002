import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../../lib/savedOutputs'
import { generateSlides, SlidesDeck } from '../../../lib/slidesAnalysis'
import { checkFrameworkConfirmed, getValidatedBlueprint, getByCardIdEntry, saveByCardIdEntry, ByCardIdContent } from '../../../lib/toolkitsShared'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'

// Toolkit: Micro-Training Slide Creator (slides). Generates a real teaching
// deck for ONE of the member's validated Blueprints.
//
// Gate: framework.confirmed AND the specific member-selected card_id is
// validated and belongs to this user (checked precisely by id, not just "the
// user has at least one validated card somewhere" — a generic existence
// check would let a request pass an unvalidated or someone else's card_id).
//
// GET ?card_id=<id>: return that one stored deck (404 if none). GET with no
// card_id: return the full by_card_id map for this user.
// POST { card_id }: generate a fresh deck for that Blueprint, persist as a
// draft (confirmed: false) keyed by card_id, and return it.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const cardId = typeof req.query.card_id === 'string' ? req.query.card_id : undefined
      if (cardId) {
        const entry = await getByCardIdEntry<SlidesDeck>(userId, 'slides', cardId)
        if (!entry) return res.status(404).json({ error: 'No slide deck generated yet for this card_id' })
        return res.status(200).json(entry)
      }
      const saved = await getSavedOutput(userId, 'slides')
      const content = (saved?.content as ByCardIdContent<SlidesDeck> | undefined) ?? { by_card_id: {} }
      return res.status(200).json(content)
    } catch (err) {
      console.error('[toolkits/slides/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load slides' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  try {
    const frameworkGate = await checkFrameworkConfirmed(userId)
    if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

    const blueprintGate = await getValidatedBlueprint(userId, body.card_id)
    if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

    const audienceRow = await getSavedOutput(userId, 'audience')
    const voiceContext = await getVoiceContext(userId)

    const frameworkContext = {
      frameworkName: frameworkGate.framework.frameworkName,
      frameworkTagline: frameworkGate.framework.frameworkTagline,
      phases: frameworkGate.framework.phases,
    }

    const generated = await generateSlides(
      frameworkContext,
      blueprintGate.card,
      audienceRow ? stripSessionHistory(audienceRow.content) : {},
      voiceContext
    )

    if (!generated.training_title || generated.slides.length < 10 || generated.slides.length > 12) {
      console.error('[toolkits/slides/analyze] generation returned malformed output', {
        training_title: generated.training_title,
        slide_count: generated.slides.length,
      })
      return res.status(502).json({ error: 'Slides generation failed' })
    }

    const deck: SlidesDeck = { ...generated, confirmed: false }
    const updated = await saveByCardIdEntry(userId, 'slides', blueprintGate.card.id, deck)

    return res.status(200).json(updated.by_card_id[blueprintGate.card.id])
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[toolkits/slides/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[toolkits/slides/analyze] POST', err)
    return res.status(500).json({ error: 'Slides generation failed' })
  }
}
