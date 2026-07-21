import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors } from '../../lib/cors'
import { supabase } from '../../lib/supabase'
import { getSavedOutput, saveOutput, stripSessionHistory } from '../../lib/savedOutputs'
import { checkFrameworkConfirmed, checkCoreOffersConfirmed, getValidatedBlueprint } from '../../lib/toolkitsShared'
import { getCoachVoiceContext } from '../../lib/voiceGuide'
import { GenerationParseError } from '../../lib/aiJson'
import { generateAICoach, validateAICoachConfig, AICoachContent, AICoachBlueprint } from '../../lib/aiCoach'

// POST /api/ai-coach/generate { config } — generate the coach's account-level AI
// Coach persona from their confirmed framework + core offers, 1-2 blueprints,
// audience, and voice guide. Persists a draft (confirmed: false) and returns it.
export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return
  if (!(await requireCapability(userId, 'toolkits', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const parsed = validateAICoachConfig(body.config)
  if (!parsed.ok) return res.status(400).json({ error: parsed.error })
  const cfg = parsed.config

  try {
    // Each card_id must be one of THIS user's validated blueprints.
    const blueprints: AICoachBlueprint[] = []
    for (const cardId of cfg.card_ids) {
      const gate = await getValidatedBlueprint(userId, cardId)
      if (!gate.ok) return res.status(400).json({ error: `card_ids: ${gate.error}` })
      blueprints.push({
        card_name: gate.card.card_name,
        problem_text: gate.card.problem_text,
        reasoning: gate.card.reasoning,
        suggested_offer: gate.card.suggested_offer,
      })
    }

    // The AI Coach needs the confirmed monetization context.
    const coreGate = await checkCoreOffersConfirmed(userId)
    if (!coreGate.ok) return res.status(400).json({ error: 'core_offers_not_confirmed — confirm your core offers before building the AI Coach' })
    const frameworkGate = await checkFrameworkConfirmed(userId)
    if (!frameworkGate.ok) return res.status(400).json({ error: 'framework_not_confirmed — confirm your results framework before building the AI Coach' })

    const [audienceRow, userRow, voiceContext] = await Promise.all([
      getSavedOutput(userId, 'audience'),
      supabase.from('users').select('name').eq('id', userId).maybeSingle(),
      getCoachVoiceContext(userId),
    ])

    const coach_name = typeof userRow.data?.name === 'string' && userRow.data.name.trim().length > 0 ? userRow.data.name.trim() : 'the coach'
    const bot_name = cfg.coach_bot_name

    const { system_prompt, deployment_instructions } = await generateAICoach({
      userId,
      coach_name,
      bot_name,
      blueprints,
      audience: audienceRow ? stripSessionHistory(audienceRow.content) : null,
      coreOffers: { low_ticket: coreGate.coreOffers.low_ticket, high_ticket: coreGate.coreOffers.high_ticket },
      framework: {
        frameworkName: frameworkGate.framework.frameworkName,
        frameworkTagline: frameworkGate.framework.frameworkTagline,
        phases: frameworkGate.framework.phases,
      },
      goal: cfg.goal,
      disqualifying_questions: cfg.disqualifying_questions,
      platform: cfg.platform,
      voiceContext,
    })

    if (!system_prompt) {
      console.error('[ai-coach/generate] generation returned empty system_prompt')
      return res.status(502).json({ error: 'AI Coach generation failed' })
    }

    const content: AICoachContent = {
      config: cfg,
      coach_name,
      bot_name,
      system_prompt,
      deployment_instructions,
      confirmed: false,
    }

    await saveOutput(userId, 'ai_coach', content)

    return res.status(200).json(content)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[ai-coach/generate] generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[ai-coach/generate] POST', err)
    return res.status(500).json({ error: 'AI Coach generation failed' })
  }
}
