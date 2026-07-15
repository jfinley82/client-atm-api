import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../../lib/savedOutputs'
import { generateQualifier, QualifierDeck, QualifierPlatform } from '../../../lib/qualifierAnalysis'
import {
  checkAudienceComplete,
  checkCoreOffersConfirmed,
  getValidatedBlueprint,
  getByCardIdEntry,
  saveByCardIdEntry,
  ByCardIdContent,
} from '../../../lib/toolkitsShared'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'
import { checkSyncGate } from '../../../lib/syncGate'
import { requireCapability } from '../../../lib/entitlements'

const VALID_PLATFORMS: QualifierPlatform[] = ['chatgpt', 'claude']

// Toolkit: AI Coach Builder (qualifier). Generates a copy-paste system
// prompt for a ChatGPT/Claude assistant that qualifies a prospect around ONE
// validated Blueprint and steers toward book-a-call / low_ticket / high_ticket.
//
// Gate (all explicit, per the Toolkits Architecture Reference Section 5d):
// audience.completed AND the specific member-selected card_id is validated
// and belongs to this user AND core_offers.confirmed (needs real offer
// content for all 3 conversion paths — cannot generate against placeholders).
//
// GET ?card_id=<id>: return that one stored qualifier (404 if none). GET with
// no card_id: return the full by_card_id map for this user.
// POST { card_id, platform }: generate a fresh qualifier, persist as a draft
// (confirmed: false) keyed by card_id, and return it.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const cardId = typeof req.query.card_id === 'string' ? req.query.card_id : undefined
      if (cardId) {
        const entry = await getByCardIdEntry<QualifierDeck>(userId, 'qualifier', cardId)
        if (!entry) return res.status(404).json({ error: 'No qualifier generated yet for this card_id' })
        return res.status(200).json(entry)
      }
      const saved = await getSavedOutput(userId, 'qualifier')
      const content = (saved?.content as ByCardIdContent<QualifierDeck> | undefined) ?? { by_card_id: {} }
      return res.status(200).json(content)
    } catch (err) {
      console.error('[toolkits/qualifier/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load qualifier' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  // Capability gate — toolkits require beta/full (admin bypasses); see lib/entitlements.ts
  if (!(await requireCapability(userId, 'toolkits', res))) return

  // The coach's real account name is still needed below (injected into the
  // generated qualifier as a real fact) — fetched separately now that the
  // capability gate no longer pulls a user row here.
  const { data: gateUser } = await supabase
    .from('users')
    .select('name')
    .eq('id', userId)
    .single()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const platform = typeof body.platform === 'string' ? body.platform : ''
  if (!VALID_PLATFORMS.includes(platform as QualifierPlatform)) {
    return res.status(400).json({ error: 'platform_required' })
  }

  try {
    const audienceGate = await checkAudienceComplete(userId)
    if (!audienceGate.ok) return res.status(400).json({ error: audienceGate.error })

    const blueprintGate = await getValidatedBlueprint(userId, body.card_id)
    if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

    const coreOffersGate = await checkCoreOffersConfirmed(userId)
    if (!coreOffersGate.ok) return res.status(400).json({ error: coreOffersGate.error })

    const syncGate = await checkSyncGate(userId, 'qualifier')
    if (!syncGate.ok) {
      return res.status(409).json({ error: 'out_of_sync', blocking: syncGate.blocking, stale_items: syncGate.stale_items })
    }

    const audienceRow = await getSavedOutput(userId, 'audience')
    const voiceContext = await getVoiceContext(userId)
    // Real account fact, not model-generated — see lib/qualifierAnalysis.ts's
    // QualifierDeck comment for why this is injected rather than asked for.
    const coachName = typeof gateUser?.name === 'string' && gateUser.name.trim().length > 0 ? gateUser.name : 'your coach'

    const generated = await generateQualifier(
      userId,
      coachName,
      stripSessionHistory(audienceRow!.content),
      blueprintGate.card,
      { low_ticket: coreOffersGate.coreOffers.low_ticket, high_ticket: coreOffersGate.coreOffers.high_ticket },
      platform as QualifierPlatform,
      voiceContext
    )

    if (!generated.system_prompt) {
      console.error('[toolkits/qualifier/analyze] generation returned malformed output', {
        system_prompt_length: generated.system_prompt.length,
      })
      return res.status(502).json({ error: 'Qualifier generation failed' })
    }

    const deck: QualifierDeck = {
      coach_name: coachName,
      system_prompt: generated.system_prompt,
      deployment_instructions: generated.deployment_instructions,
      confirmed: false,
    }

    const updated = await saveByCardIdEntry(userId, 'qualifier', blueprintGate.card.id, deck)

    return res.status(200).json(updated.by_card_id[blueprintGate.card.id])
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[toolkits/qualifier/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[toolkits/qualifier/analyze] POST', err)
    return res.status(500).json({ error: 'Qualifier generation failed' })
  }
}
