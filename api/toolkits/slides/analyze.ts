import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../../lib/savedOutputs'
import { generateSlides, SlidesDeck } from '../../../lib/slidesAnalysis'
import { checkFrameworkConfirmed, getValidatedBlueprint, getByCardIdEntry } from '../../../lib/toolkitsShared'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'
import { checkSyncGate } from '../../../lib/syncGate'
import { stampSyncSnapshot } from '../../../lib/syncDependencies'
import { deckSlidesToCanonical, canonicalRowToDeck, frameworkPhaseNames } from '../../../lib/slidesCanonical'

// Toolkit: Micro-Training Creator (slides). Now a thin editor of the CANONICAL
// mtm_generations.slides column (Task 5 consolidation) — slides no longer live
// in saved_outputs[slides].by_card_id. The SlidesDeck API shape is preserved by
// mapping to/from canonical (see lib/slidesCanonical.ts). The row's staleness
// snapshot lives in mtm_generations.sync_snapshot, stamped on every write.
//
// GET ?card_id=<id>: the canonical deck (with a read-through migration of a
// legacy by_card_id deck if the canonical slides are still empty). GET with no
// card_id: the by_card_id-shaped map built from the user's canonical rows.
// POST { card_id }: generate a fresh deck, write it to the canonical row.

// Writes a deck's slides to the canonical mtm_generations row for (user, card),
// stamping the 'slides' sync snapshot. Upserts on (user_id, card_id) so a card
// that has no generation row yet gets one.
async function writeCanonicalDeck(userId: string, cardId: string, deck: SlidesDeck, phaseNames: string[]) {
  const sync_snapshot = await stampSyncSnapshot(userId, 'slides', cardId)
  const { data, error } = await supabase
    .from('mtm_generations')
    .upsert(
      {
        user_id: userId,
        card_id: cardId,
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
  return canonicalRowToDeck(data)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const cardId = typeof req.query.card_id === 'string' ? req.query.card_id : undefined
      if (cardId) {
        const { data: row, error } = await supabase
          .from('mtm_generations')
          .select('slides, chosen_topic, total_duration')
          .eq('user_id', userId)
          .eq('card_id', cardId)
          .maybeSingle()
        if (error) throw error
        if (row && Array.isArray(row.slides) && row.slides.length > 0) {
          return res.status(200).json(canonicalRowToDeck(row))
        }
        // Read-through migration: a legacy by_card_id deck with no canonical
        // slides yet is migrated into the canonical row on first read.
        const legacy = await getByCardIdEntry<SlidesDeck>(userId, 'slides', cardId)
        if (legacy && Array.isArray(legacy.slides) && legacy.slides.length > 0) {
          const frameworkRow = await getSavedOutput(userId, 'framework')
          const migrated = await writeCanonicalDeck(userId, cardId, legacy, frameworkPhaseNames(frameworkRow?.content))
          return res.status(200).json(migrated)
        }
        return res.status(404).json({ error: 'No slide deck generated yet for this card_id' })
      }

      // No card_id — the by_card_id-shaped map, now built from canonical rows.
      const { data: rows, error } = await supabase
        .from('mtm_generations')
        .select('card_id, slides, chosen_topic, total_duration')
        .eq('user_id', userId)
      if (error) throw error
      const by_card_id: Record<string, SlidesDeck> = {}
      for (const row of rows || []) {
        if (Array.isArray(row.slides) && row.slides.length > 0) by_card_id[row.card_id as string] = canonicalRowToDeck(row)
      }
      return res.status(200).json({ by_card_id })
    } catch (err) {
      console.error('[toolkits/slides/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load slides' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  // Capability gate — toolkits require beta/full (admin bypasses); see lib/entitlements.ts
  if (!(await requireCapability(userId, 'toolkits', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  try {
    const frameworkGate = await checkFrameworkConfirmed(userId)
    if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

    const blueprintGate = await getValidatedBlueprint(userId, body.card_id)
    if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

    const syncGate = await checkSyncGate(userId, 'slides')
    if (!syncGate.ok) {
      return res.status(409).json({ error: 'out_of_sync', blocking: syncGate.blocking, stale_items: syncGate.stale_items })
    }

    const audienceRow = await getSavedOutput(userId, 'audience')
    const voiceContext = await getVoiceContext(userId)

    const frameworkContext = {
      frameworkName: frameworkGate.framework.frameworkName,
      frameworkTagline: frameworkGate.framework.frameworkTagline,
      phases: frameworkGate.framework.phases,
    }

    const generated = await generateSlides(
      userId,
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
    const saved = await writeCanonicalDeck(userId, blueprintGate.card.id, deck, frameworkPhaseNames(frameworkGate.framework))

    return res.status(200).json(saved)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[toolkits/slides/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[toolkits/slides/analyze] POST', err)
    return res.status(500).json({ error: 'Slides generation failed' })
  }
}
