import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, stripSessionHistory } from '../../lib/savedOutputs'
import { getVoiceContext } from '../../lib/voiceGuide'
import { requireCapability } from '../../lib/entitlements'
import { checkFrameworkConfirmed, getValidatedBlueprint } from '../../lib/toolkitsShared'
import { GenerationParseError } from '../../lib/aiJson'
import {
  generateMicroTraining,
  DeliveryInput,
  GeneratorInputs,
} from '../../lib/microTrainingGenerator'

// POST /api/generate — the unified Micro-Training generator. From ONE validated
// blueprint plus the coach's delivery choices, it produces and persists the full
// Step 4 (Build) / Step 5 (Launch) asset set into the canonical mtm_generations
// row for (user_id, card_id). No content is entered by the caller — audience,
// transformation, confirmed framework, the chosen blueprint, and the voice guide
// are all loaded server-side. See lib/microTrainingGenerator.ts.
//
// The generation runs as six parallel Anthropic calls (one per asset group) to
// stay inside maxDuration 60; a single call for the whole set would truncate or
// run past the ceiling.
export const config = { maxDuration: 60 }

const DURATIONS = new Set(['60', '90', '120'])
const FORMATS = new Set(['virtual', 'in-person', 'hybrid'])

function parseDelivery(raw: unknown): DeliveryInput | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.duration !== 'string' || !DURATIONS.has(d.duration)) return null
  if (typeof d.format !== 'string' || !FORMATS.has(d.format)) return null
  if (typeof d.facilitator_name !== 'string' || d.facilitator_name.trim().length === 0) return null
  const delivery: DeliveryInput = {
    duration: d.duration as DeliveryInput['duration'],
    format: d.format as DeliveryInput['format'],
    facilitator_name: d.facilitator_name.trim(),
  }
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

    const delivery = parseDelivery(body.delivery)
    if (!delivery) {
      return res.status(400).json({
        error:
          "delivery required — { duration: '60'|'90'|'120', format: 'virtual'|'in-person'|'hybrid', facilitator_name (non-empty), soft_cta?, call_page_url? }",
      })
    }
    // Preserve an existing coach-chosen title only when the caller opts in.
    const keepTitle = body.keep_title === true

    // Capability gate — toolkits require beta/full (admin bypasses).
    if (!(await requireCapability(userId, 'toolkits', res))) return

    try {
      const blueprintGate = await getValidatedBlueprint(userId, card_id)
      if (!blueprintGate.ok) return res.status(400).json({ error: blueprintGate.error })

      const frameworkGate = await checkFrameworkConfirmed(userId)
      if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

      const [audienceRow, transformationRow, existingRow, voiceContext] = await Promise.all([
        getSavedOutput(userId, 'audience'),
        getSavedOutput(userId, 'transformation'),
        supabase.from('mtm_generations').select('chosen_topic').eq('user_id', userId).eq('card_id', card_id).maybeSingle(),
        getVoiceContext(userId),
      ])

      const inputs: GeneratorInputs = {
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
        delivery,
        voiceContext,
      }

      const generated = await generateMicroTraining(userId, inputs)

      // chosen_topic is never null on success. Keep the coach's existing title
      // only when keep_title was passed and a non-empty one is already stored.
      const existingChosen = (existingRow.data?.chosen_topic ?? '') as string
      const chosen_topic = keepTitle && existingChosen.trim().length > 0 ? existingChosen : generated.chosen_topic

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
            facilitator_tips: generated.facilitator_tips,
            delivery,
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
