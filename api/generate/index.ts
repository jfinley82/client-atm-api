import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../lib/savedOutputs'
import { getVoiceContext } from '../../lib/voiceGuide'
import { requireCapability } from '../../lib/entitlements'
import { checkFrameworkConfirmed, getValidatedBlueprint } from '../../lib/toolkitsShared'
import { stampSyncSnapshot } from '../../lib/syncDependencies'
import { GenerationParseError } from '../../lib/aiJson'
import {
  generateMicroTraining,
  regenerateAsset,
  regenerateScript,
  DeliveryInput,
  GeneratorInputs,
  MtSlide,
} from '../../lib/microTrainingGenerator'

// POST /api/generate — the unified Micro-Training generator. From ONE validated
// blueprint plus a few optional recording details, it produces and persists the
// full Step 4 (Build) / Step 5 (Launch) asset set into the canonical
// mtm_generations row for (user_id, card_id). The Micro-Training is a single
// 15-20 minute recorded video. No content is entered by the caller — audience,
// transformation, confirmed framework, the chosen blueprint, and the voice guide
// are all loaded server-side. See lib/microTrainingGenerator.ts.
//
// The generation runs as six parallel Anthropic calls (one per asset group) to
// stay inside maxDuration 60; a single call for the whole set would truncate or
// run past the ceiling.
export const config = { maxDuration: 60 }

const REGEN_TARGETS = new Set([
  'slides',
  'emails',
  'book_a_call',
  'workbook',
  'recording_tips',
  'script',
  'topics',
  'outline',
])

// Recording details are all optional (no duration/format — the video is a fixed
// 15-20 minutes). Always returns an object; presenter_name defaults to the
// coach's account name later.
function parseDelivery(raw: unknown): DeliveryInput {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const delivery: DeliveryInput = {}
  if (typeof d.presenter_name === 'string' && d.presenter_name.trim().length > 0) delivery.presenter_name = d.presenter_name.trim()
  if (typeof d.soft_cta === 'string' && d.soft_cta.trim().length > 0) delivery.soft_cta = d.soft_cta.trim()
  if (typeof d.call_page_url === 'string' && d.call_page_url.trim().length > 0) delivery.call_page_url = d.call_page_url.trim()
  return delivery
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const card_id = typeof body.card_id === 'string' ? body.card_id : ''
    if (!card_id) return res.status(400).json({ error: 'card_id required' })

    // Choose / swap title — set chosen_topic with NO regeneration (instant
    // relabel). Accepts any topics[].title or free text. Handled before any
    // grounding load since nothing is generated.
    if (typeof body.choose_title === 'string') {
      const title = body.choose_title.trim()
      if (!title) return res.status(400).json({ error: 'choose_title must be a non-empty string' })
      if (!(await requireCapability(userId, 'toolkits', res))) return
      try {
        const { data, error } = await supabase
          .from('mtm_generations')
          .update({ chosen_topic: title, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .maybeSingle()
        if (error) throw error
        if (!data) return res.status(404).json({ error: 'No generation for this card yet' })
        return res.status(200).json(data)
      } catch (err) {
        console.error('[generate] POST choose_title', err)
        return res.status(500).json({ error: 'Failed to set title' })
      }
    }

    // A regenerate request rebuilds ONE asset conditioned on the current
    // chosen_topic and reuses the stored delivery. A full generate takes optional
    // recording details in the body (no content).
    const regenerate = typeof body.regenerate === 'string' ? body.regenerate : null
    const keepTitle = body.keep_title === true

    let delivery: DeliveryInput | null = null
    if (regenerate) {
      if (!REGEN_TARGETS.has(regenerate)) {
        return res.status(400).json({
          error: 'regenerate must be one of: slides, emails, book_a_call, workbook, recording_tips, script, topics, outline',
        })
      }
    } else {
      // Optional recording details only — { presenter_name?, soft_cta?, call_page_url? }.
      delivery = parseDelivery(body.delivery)
    }

    // Capability gate — toolkits require beta/full (admin bypasses).
    if (!(await requireCapability(userId, 'toolkits', res))) return

    try {
      const blueprintGate = await getValidatedBlueprint(userId, card_id)
      if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

      const frameworkGate = await checkFrameworkConfirmed(userId)
      if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

      const [audienceRow, transformationRow, existingRow, userRow, voiceContext] = await Promise.all([
        getSavedOutput(userId, 'audience'),
        getSavedOutput(userId, 'transformation'),
        supabase
          .from('mtm_generations')
          .select('chosen_topic, delivery, slides')
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .maybeSingle(),
        supabase.from('users').select('name').eq('id', userId).maybeSingle(),
        getVoiceContext(userId),
      ])
      const existing = existingRow.data
      // presenter_name defaults to the coach's account name when not supplied.
      const accountName = typeof userRow.data?.name === 'string' ? userRow.data.name.trim() : ''
      const withPresenter = (dv: DeliveryInput): DeliveryInput =>
        dv.presenter_name || !accountName ? dv : { ...dv, presenter_name: accountName }

      const baseInputs: Omit<GeneratorInputs, 'delivery'> = {
        audience: audienceRow ? stripSessionHistory(audienceRow.content) : null,
        transformation: transformationRow ? stripSessionHistory(transformationRow.content) : null,
        framework: {
          frameworkName: frameworkGate.framework.frameworkName,
          frameworkTagline: frameworkGate.framework.frameworkTagline,
          phases: frameworkGate.framework.phases,
        },
        card: {
          id: blueprintGate.card.id,
          card_name: blueprintGate.card.card_name,
          problem_text: blueprintGate.card.problem_text,
          reasoning: blueprintGate.card.reasoning,
          suggested_offer: blueprintGate.card.suggested_offer,
        },
        voiceContext,
      }

      // ── Regenerate one asset ── conditioned on the stored chosen_topic +
      // delivery, writing back only that asset's column(s).
      if (regenerate) {
        if (!existing) return res.status(404).json({ error: 'No generation to regenerate — run a full generate first' })
        const inputs: GeneratorInputs = { ...baseInputs, delivery: withPresenter(parseDelivery(existing.delivery)) }
        const chosenTopic = typeof existing.chosen_topic === 'string' ? existing.chosen_topic : ''

        const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
        switch (regenerate) {
          case 'slides':
            update.slides = (await regenerateAsset(userId, 'slides', inputs, chosenTopic)).slides
            break
          case 'emails':
            update.emails = (await regenerateAsset(userId, 'emails', inputs, chosenTopic)).emails
            break
          case 'book_a_call':
            update.book_a_call_emails = (await regenerateAsset(userId, 'book_a_call', inputs, chosenTopic)).book_a_call_emails
            break
          case 'workbook':
            update.workbook = (await regenerateAsset(userId, 'workbook', inputs, chosenTopic)).workbook
            break
          case 'recording_tips':
            update.recording_tips = (await regenerateAsset(userId, 'recording_tips', inputs, chosenTopic)).recording_tips
            break
          case 'topics':
            update.topics = (await regenerateAsset(userId, 'meta', inputs, chosenTopic)).topics
            break
          case 'outline':
            update.outline = (await regenerateAsset(userId, 'meta', inputs, chosenTopic)).outline
            break
          case 'script': {
            const cur = Array.isArray(existing.slides) ? (existing.slides as MtSlide[]) : []
            update.slides = await regenerateScript(userId, inputs, cur, chosenTopic)
            break
          }
        }
        // Rebuilding the slides re-stamps the 'slides' staleness snapshot.
        if (regenerate === 'slides' || regenerate === 'script') {
          update.sync_snapshot = await stampSyncSnapshot(userId, 'slides', card_id)
        }

        const { data, error } = await supabase
          .from('mtm_generations')
          .update(update)
          .eq('user_id', userId)
          .eq('card_id', card_id)
          .select()
          .single()
        if (error) throw error
        return res.status(200).json(data)
      }

      // ── Full generate ──
      const resolvedDelivery = withPresenter(delivery!)
      const inputs: GeneratorInputs = { ...baseInputs, delivery: resolvedDelivery }
      const generated = await generateMicroTraining(userId, inputs)

      // chosen_topic is never null on success. Keep the coach's existing title
      // only when keep_title was passed and a non-empty one is already stored.
      const existingChosen = (existing?.chosen_topic ?? '') as string
      const chosen_topic = keepTitle && existingChosen.trim().length > 0 ? existingChosen : generated.chosen_topic

      // A full generate builds the slides, so it stamps the 'slides' staleness snapshot.
      const sync_snapshot = await stampSyncSnapshot(userId, 'slides', card_id)

      const { data, error } = await supabase
        .from('mtm_generations')
        .upsert(
          {
            user_id: userId,
            card_id,
            topics: generated.topics,
            chosen_topic,
            subtitle: generated.subtitle,
            total_duration: generated.total_duration,
            outline: generated.outline,
            slides: generated.slides,
            workbook: generated.workbook,
            emails: generated.emails,
            book_a_call_emails: generated.book_a_call_emails,
            recording_tips: generated.recording_tips,
            delivery: resolvedDelivery,
            sync_snapshot,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,card_id' }
        )
        .select()
        .single()

      if (error) throw error
      return res.status(200).json(data)
    } catch (err) {
      if (err instanceof GenerationParseError) {
        console.error('[generate] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
        return res.status(502).json({ error: 'generation_truncated' })
      }
      console.error('[generate] POST', err)
      return res.status(500).json({ error: 'Generation failed' })
    }
  }

  if (req.method === 'GET') {
    const rawId = req.query && req.query.id
    const id = Array.isArray(rawId) ? rawId[0] : rawId

    // GET with id — return a single generation (must belong to the user)
    if (id && typeof id === 'string') {
      try {
        const { data, error } = await supabase
          .from('mtm_generations')
          .select('*')
          .eq('id', id)
          .eq('user_id', userId)
          .maybeSingle()

        if (error) throw error
        if (!data) return res.status(404).json({ error: 'Generation not found' })
        return res.status(200).json(data)
      } catch (err) {
        console.error('[generate] GET one', err)
        return res.status(500).json({ error: 'Failed to load generation' })
      }
    }

    // GET with card_id — return the canonical generation row for that card.
    const rawCardId = req.query && req.query.card_id
    const cardId = Array.isArray(rawCardId) ? rawCardId[0] : rawCardId
    if (cardId && typeof cardId === 'string') {
      try {
        const { data, error } = await supabase
          .from('mtm_generations')
          .select('*')
          .eq('card_id', cardId)
          .eq('user_id', userId)
          .maybeSingle()

        if (error) throw error
        return res.status(200).json(data ?? null)
      } catch (err) {
        console.error('[generate] GET by card_id', err)
        return res.status(500).json({ error: 'Failed to load generation' })
      }
    }

    // GET — list all generations for the user, with the card name joined in
    try {
      const { data, error } = await supabase
        .from('mtm_generations')
        .select('*, problem_solution_cards(card_name)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (error) throw error

      const rows = (data || []).map((r: any) => {
        const { problem_solution_cards, ...rest } = r
        return { ...rest, card_name: problem_solution_cards?.card_name ?? null }
      })

      return res.status(200).json(rows)
    } catch (err) {
      console.error('[generate] GET list', err)
      return res.status(500).json({ error: 'Failed to load generations' })
    }
  }

  return res.status(405).end()
}
