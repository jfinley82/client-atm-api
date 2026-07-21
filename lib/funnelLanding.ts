import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { GENDER_NEUTRAL_INSTRUCTION } from './promptGuidelines'
import { getCoachVoiceContext } from './voiceGuide'
import { getSavedOutput, stripSessionHistory } from './savedOutputs'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// The generated landing-page copy — the exact shape the public renderer and the
// studio editor read. Three problem bullets, three solution bullets, a headline,
// a subheadline, and a call-to-action label.
export type LandingPage = {
  headline: string
  subheadline: string
  problem_bullets: string[]
  solution_bullets: string[]
  cta_label: string
}

// The frozen problem/solution tagging stored on the funnel at creation and
// inherited by every lead. Derived from the chosen blueprint (a
// problem_solution_cards row).
export type BlueprintSnapshot = {
  card_id: string
  card_name: string | null
  surface_problem: string | null
  real_problem: string | null
  your_solution: string | null
  transformation: string | null
  natural_bridge: string | null
  hook_angle: string | null
}

// Snapshot the blueprint's problem/solution into the frozen shape stored on the
// funnel (problem_solution_snapshot) and used to ground generation. Accepts a
// raw problem_solution_cards row.
export function blueprintSnapshot(card: Record<string, any>): BlueprintSnapshot {
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null)
  return {
    card_id: String(card.id),
    card_name: s(card.card_name),
    surface_problem: s(card.surface_problem),
    real_problem: s(card.real_problem),
    your_solution: s(card.your_solution),
    transformation: s(card.transformation),
    natural_bridge: s(card.natural_bridge),
    hook_angle: s(card.hook_angle),
  }
}

const LANDING_PROMPT = `You are a direct-response copywriter helping a coach turn their finished Micro-Training blueprint into the copy for a single landing page. The page's only job is to make the right person feel understood in seconds and opt in to watch a short training. Reason specifically from the coach's own audience, transformation, and blueprint data provided — never generic coaching-industry copy.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "headline": "the single most important line on the page — names the specific person and the specific outcome or problem, in their language, not a clever slogan",
  "subheadline": "one sentence under the headline that adds the mechanism or the stakes, giving the visitor a concrete reason to keep reading",
  "problem_bullets": ["a specific pain this person feels in their own words", "a second, genuinely distinct pain", "a third, genuinely distinct pain"],
  "solution_bullets": ["a specific thing they'll be able to do or understand after the training, tied to the coach's actual solution", "a second distinct payoff", "a third distinct payoff"],
  "cta_label": "the button text — short, first-person or action-led, specific to watching the training (not a generic 'Submit')"
}

Rules:
- problem_bullets and solution_bullets must each have EXACTLY 3 entries, each genuinely distinct — not three rewordings of one idea.
- Ground every line in the specific data provided (the audience's language and pains, the transformation before/after, the blueprint's surface_problem, real_problem, your_solution, transformation). Use the audience's own words where it strengthens a line.
- The solution_bullets describe what the visitor gains from the free training, not a hard pitch of a paid offer.
- Keep it tight and human. No hype, no fake urgency, no invented statistics.
${GENDER_NEUTRAL_INSTRUCTION}`

function normalizeBullets(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
}

/**
 * Generate the landing-page copy for a funnel, grounded on the coach's saved
 * audience + transformation + framework + core_offers outputs and the chosen
 * blueprint. Applies the app's anti-AI style layer with voice precedence
 * (getCoachVoiceContext: the coach's confirmed voice guide wins when present,
 * otherwise the shared style guide alone). Persists nothing — the caller writes
 * the returned object onto the funnel row.
 */
export async function generateLandingPage(userId: string, blueprint: BlueprintSnapshot): Promise<LandingPage> {
  const [audienceRow, transformationRow, frameworkRow, coreOffersRow, voiceContext] = await Promise.all([
    getSavedOutput(userId, 'audience'),
    getSavedOutput(userId, 'transformation'),
    getSavedOutput(userId, 'framework'),
    getSavedOutput(userId, 'core_offers'),
    // Voice precedence: coach's confirmed voice guide is authoritative; falls
    // back to the shared style guide alone when no complete guide exists.
    getCoachVoiceContext(userId),
  ])

  const grounding = {
    audience: stripSessionHistory(audienceRow?.content) ?? null,
    transformation: stripSessionHistory(transformationRow?.content) ?? null,
    framework: frameworkRow?.content ?? null,
    core_offers: coreOffersRow?.content ?? null,
    blueprint,
  }

  const userMessage = `COACH BLUEPRINT + AUDIENCE DATA:
${JSON.stringify(grounding)}

Write the landing page copy now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    thinking: { type: 'disabled' },
    // voiceContext already carries the STYLE_GUIDELINES layer (see
    // getCoachVoiceContext), so it is appended once here — do not add
    // STYLE_GUIDELINES separately or it double-injects.
    system: `${LANDING_PROMPT}\n\n${voiceContext}`,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(userId, 'funnel_landing', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const parsed = extractJson(textBlock?.text ?? '')

  return {
    headline: typeof parsed.headline === 'string' ? parsed.headline.trim() : '',
    subheadline: typeof parsed.subheadline === 'string' ? parsed.subheadline.trim() : '',
    problem_bullets: normalizeBullets(parsed.problem_bullets),
    solution_bullets: normalizeBullets(parsed.solution_bullets),
    cta_label: typeof parsed.cta_label === 'string' && parsed.cta_label.trim() ? parsed.cta_label.trim() : 'Watch the free training',
  }
}

// True once the generated copy is usable enough to publish — a headline and at
// least one problem and one solution bullet. Used by the publish gate and to
// decide whether generation succeeded.
export function landingPageHasCopy(lp: unknown): lp is LandingPage {
  if (!lp || typeof lp !== 'object') return false
  const p = lp as Partial<LandingPage>
  return (
    typeof p.headline === 'string' &&
    p.headline.trim().length > 0 &&
    Array.isArray(p.problem_bullets) &&
    p.problem_bullets.length > 0 &&
    Array.isArray(p.solution_bullets) &&
    p.solution_bullets.length > 0
  )
}
