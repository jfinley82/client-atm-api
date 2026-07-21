import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors } from '../../lib/cors'
import {
  getSavedOutput,
  saveOutput,
  stripSessionHistory,
  extractSessionHistory,
  isContentComplete,
} from '../../lib/savedOutputs'
import { getVoiceContext } from '../../lib/voiceGuide'
import { extractJson, GenerationParseError } from '../../lib/aiJson'
import { logApiCost } from '../../lib/apiCostLog'
import { generateTransformationAnalysis, TransformationAnalysis } from '../../lib/transformationAnalysis'
import {
  generateTop10,
  generateSuggestedOffer,
  MatcherAnalysis,
  MatcherIntake,
  SuggestedOffer,
} from '../../lib/matcherAnalysis'
import { buildSystemPrompt, deriveAudienceDisplayFields } from './chat'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// A single "generate results" trigger the Steps 1-3 output panel calls once the
// chat for a step is complete. It produces + persists that step's FINALIZED
// structured output and returns it as { output } in the exact shape the
// frontend already renders for that step:
//   - audience       -> stripSessionHistory(saved 'audience' content)
//                       (same shape as GET /api/tools/audience `output`)
//   - transformation -> TransformationAnalysis (same as GET /api/tools/transformation/analyze)
//   - matcher        -> MatcherAnalysis (same as GET /api/matcher/analyze)
//
// It REUSES each step's existing per-step generation — it does not reimplement
// it — and it deliberately does NOT touch the incremental chat POST, the
// analyze endpoints, or the select/confirm flows:
//   - audience has no results/analyze endpoint today; its profile is only built
//     turn-by-turn in chat.ts. Here we run a ONE-SHOT finalize over the whole
//     completed conversation using the audience tool's OWN prompt/schema
//     (buildSystemPrompt + deriveAudienceDisplayFields, imported from chat.ts),
//     so the finalized profile matches the turn-by-turn shape exactly.
//   - transformation/matcher reuse the same lib generators the analyze
//     endpoints use (generateTransformationAnalysis / generateTop10 +
//     generateSuggestedOffer).
//
// Idempotent, single row per step (saveOutput upserts on user_id+tool_type):
//   - audience finalize runs once, marked with finalized:true on the audience
//     row; a second call returns the finalized profile without regenerating.
//   - transformation/matcher return the already-persisted analysis if one
//     exists, so a second call never clobbers a selection/confirmation made
//     through the select/confirm flows.
export const config = { maxDuration: 60 }

const STEPS = ['audience', 'transformation', 'matcher'] as const
type Step = (typeof STEPS)[number]

// One-shot finalize instruction appended after the completed transcript. Turns
// the interview prompt (which asks one question at a time and emits a cumulative
// <data> block per turn) into a single call that emits ONLY the full, final
// <data> block — the whole token budget goes to the report, not a chat reply,
// so no field gets cut off the way a late conversational turn can.
const AUDIENCE_FINALIZE_INSTRUCTION = `This interview is now complete — do not ask any more questions. Produce the FINAL Audience Profile now: output a single <data> block containing EVERY field in the schema you were given, each fully and specifically populated from the whole conversation (motivating_phrases and repelling_phrases must each have exactly 10 distinct entries; pain_points, fears_and_doubts, and sales_objections exactly 5 distinct entries each). Respond with ONLY the <data>...</data> block — no conversational text, no preamble, nothing outside the tags.`

// Runs the audience finalize and returns the raw profile merged with the derived
// display subset. Throws GenerationParseError on genuine truncation.
async function finalizeAudienceProfile(
  userId: string,
  transcript: { role: string; content: string }[]
): Promise<Record<string, unknown>> {
  const system = buildSystemPrompt('audience', 8, null)
  const messages = transcript
    .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
    .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }))
  messages.push({ role: 'user', content: AUDIENCE_FINALIZE_INSTRUCTION })

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 6000,
    thinking: { type: 'disabled' },
    system,
    messages,
  })

  await logApiCost(userId, 'audience', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  // Prefer the <data> block; fall back to parsing the whole response if the
  // model dropped the tags. extractJson throws GenerationParseError on real
  // truncation (surfaced as 502 generation_truncated below).
  const dataMatch = text.match(/<data>([\s\S]*?)<\/data>/)
  const parsed = extractJson(dataMatch ? dataMatch[1] : text)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('audience finalize produced non-object output')
  }
  const raw = parsed as Record<string, unknown>
  return { ...raw, ...deriveAudienceDisplayFields(raw) }
}

async function handleAudience(userId: string, res: VercelResponse) {
  const row = await getSavedOutput(userId, 'audience')
  if (!isContentComplete(row?.content)) {
    return res.status(400).json({ error: 'audience_incomplete' })
  }
  const content = row!.content as Record<string, unknown>

  // Already finalized once — return the persisted profile, don't regenerate.
  if (content.finalized === true) {
    return res.status(200).json({ output: stripSessionHistory(content) })
  }

  const sessionHistory = extractSessionHistory(content) as { role: string; content: string }[]
  if (sessionHistory.length === 0) {
    return res.status(400).json({ error: 'audience_incomplete' })
  }

  const profile = await finalizeAudienceProfile(userId, sessionHistory)

  // Minimal sanity check — a usable audience report always has at least an
  // avatar/problem statement or the core who_they_are field.
  const filled = (k: string) => typeof profile[k] === 'string' && (profile[k] as string).trim().length > 0
  if (!(filled('who_they_are') || filled('problem_statement') || filled('avatar_name'))) {
    return res.status(502).json({ error: 'Results generation failed' })
  }

  const finalized = { ...profile, completed: true, finalized: true, session_history: sessionHistory }
  await saveOutput(userId, 'audience', finalized)

  return res.status(200).json({ output: stripSessionHistory(finalized) })
}

async function handleTransformation(userId: string, res: VercelResponse) {
  const row = await getSavedOutput(userId, 'transformation')
  if (!isContentComplete(row?.content)) {
    return res.status(400).json({ error: 'transformation_incomplete' })
  }

  // Idempotent: return the persisted analysis if one exists, so a repeat call
  // never resets a selection/confirmation made via select/confirm.
  const existing = await getSavedOutput(userId, 'transformation_analysis')
  if (existing) {
    return res.status(200).json({ output: existing.content })
  }

  const profile = stripSessionHistory(row!.content) as Record<string, unknown>
  const voiceContext = await getVoiceContext(userId)
  const generated = await generateTransformationAnalysis(userId, profile, voiceContext)

  if (generated.selectedProblems.length !== 3) {
    console.error('[tools/results] transformation generation malformed', {
      selected_problem_count: generated.selectedProblems.length,
    })
    return res.status(502).json({ error: 'Results generation failed' })
  }

  const analysis: TransformationAnalysis = {
    ...generated,
    beforeState: typeof profile.before_state === 'string' ? profile.before_state : '',
    afterState: typeof profile.after_state === 'string' ? profile.after_state : '',
    selected_id: null,
    confirmed: false,
  }

  await saveOutput(userId, 'transformation_analysis', analysis)
  return res.status(200).json({ output: analysis })
}

async function handleMatcher(userId: string, res: VercelResponse) {
  const [audienceRow, transformationRow, intakeRow] = await Promise.all([
    getSavedOutput(userId, 'audience'),
    getSavedOutput(userId, 'transformation'),
    getSavedOutput(userId, 'matcher_intake'),
  ])

  if (!isContentComplete(audienceRow?.content)) return res.status(400).json({ error: 'audience_incomplete' })
  if (!isContentComplete(transformationRow?.content)) return res.status(400).json({ error: 'transformation_incomplete' })
  if (!isContentComplete(intakeRow?.content)) return res.status(400).json({ error: 'intake_incomplete' })

  // Idempotent: return the persisted analysis if one exists, so a repeat call
  // never resets the selection made via /api/matcher/selection.
  const existing = await getSavedOutput(userId, 'matcher_analysis')
  if (existing) {
    return res.status(200).json({ output: existing.content })
  }

  const intake = stripSessionHistory(intakeRow!.content) as MatcherIntake
  const voiceContext = await getVoiceContext(userId)

  const { top_10, recommended_ids, why_recommended, insights } = await generateTop10(
    userId,
    stripSessionHistory(audienceRow!.content),
    stripSessionHistory(transformationRow!.content),
    intake,
    voiceContext
  )

  if (top_10.length === 0 || recommended_ids.length !== 3) {
    console.error('[tools/results] matcher generation malformed', {
      top_10_count: top_10.length,
      recommended_ids_count: recommended_ids.length,
    })
    return res.status(502).json({ error: 'Results generation failed' })
  }

  const byId = new Map(top_10.map((p) => [p.id, p]))
  const offerEntries = await Promise.all(
    recommended_ids.map(async (id): Promise<[string, SuggestedOffer] | null> => {
      const problem = byId.get(id)
      if (!problem) return null
      const offer = await generateSuggestedOffer(userId, problem, intake, voiceContext)
      return [id, offer]
    })
  )

  const suggested_offers: Record<string, SuggestedOffer> = {}
  for (const entry of offerEntries) {
    if (entry) suggested_offers[entry[0]] = entry[1]
  }

  const analysis: MatcherAnalysis = {
    top_10,
    recommended_ids,
    selected_ids: recommended_ids,
    why_recommended,
    insights,
    suggested_offers,
  }

  await saveOutput(userId, 'matcher_analysis', analysis)
  return res.status(200).json({ output: analysis })
}

// POST /api/tools/results { step: 'audience' | 'transformation' | 'matcher' }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return
  if (!(await requireCapability(userId, 'toolkits', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const step = body.step
  if (typeof step !== 'string' || !STEPS.includes(step as Step)) {
    return res.status(400).json({ error: "step must be one of 'audience', 'transformation', 'matcher'" })
  }

  try {
    switch (step as Step) {
      case 'audience':
        return await handleAudience(userId, res)
      case 'transformation':
        return await handleTransformation(userId, res)
      case 'matcher':
        return await handleMatcher(userId, res)
    }
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[tools/results] generation_truncated', step, err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[tools/results] POST', step, err)
    return res.status(500).json({ error: 'Results generation failed' })
  }
}
