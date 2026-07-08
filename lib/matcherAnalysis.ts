import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type MatcherIntake = {
  has_existing_offer: boolean
  price?: string
  format?: string
  delivery?: string
}

export type MatchFactor = {
  score: number
  reasoning: string
}

export type MatchFactors = {
  audience_resonance: MatchFactor
  transformation_fit: MatchFactor
  conversion_ease: MatchFactor
  monetization_potential: MatchFactor
}

export type Top10Problem = {
  id: string
  problem: string
  reasoning: string
  match_factors: MatchFactors
  // Backend-computed average of the 4 match_factors scores — never trust the
  // model's own arithmetic, and top_10 is always re-sorted on this value
  // before being returned (see generateTop10) so display order never depends
  // on the order the model emitted entries in.
  match_strength: number
}

export type SuggestedOffer = {
  has_existing_offer: boolean
  name: string | null
  format: string | null
  price_point: string | null
  angle_note: string
}

export type MatcherAnalysis = {
  top_10: Top10Problem[]
  recommended_ids: string[]
  selected_ids: string[]
  why_recommended: string
  insights: string
  suggested_offers: Record<string, SuggestedOffer>
}

const TOP_10_PROMPT = `You are an expert offer strategist for coaches. You are given a coach's complete audience intelligence, their transformation data, and their current business context. Identify the 10 most monetizable problems this specific coach could build a paid offer around — grounded in THEIR audience and transformation data, not generic coaching advice.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "top_10": [
    {
      "id": "p1",
      "problem": "a specific, monetizable problem statement",
      "reasoning": "connect one specific detail from the audience intelligence to one specific detail from the transformation data by name — do not speak generically",
      "match_factors": {
        "audience_resonance": { "score": <integer 1-10>, "reasoning": "one sentence" },
        "transformation_fit": { "score": <integer 1-10>, "reasoning": "one sentence" },
        "conversion_ease": { "score": <integer 1-10>, "reasoning": "one sentence" },
        "monetization_potential": { "score": <integer 1-10>, "reasoning": "one sentence" }
      }
    }
  ],
  "recommended_ids": ["p_", "p_", "p_"],
  "why_recommended": "a specific explanation of why these 3 beat the other 7, referencing specifics from the data",
  "insights": "a specific pattern or connection across the audience and transformation data the coach has likely not connected themselves — not a summary of what they already said"
}

Rules:
- top_10 must have exactly 10 entries, ids "p1" through "p10", each a genuinely distinct problem — not 10 rephrasings of the same idea.
- Ground every reasoning field in specifics from the data provided (e.g. real_problem, internal_dialogue, tried_before, the_bridge, proof_point) — name what you are drawing from, do not speak in generalities.
- recommended_ids must have exactly 3 ids, chosen for being felt urgently, addressable by this coach's specific transformation capability, and likely to create natural demand for more help.
- match_factors: score EVERY one of the 10 entries on all 4 factors below, 1-10, using ONLY the data already provided in this prompt — no outside knowledge, no invented facts. Scores must genuinely differentiate across the 10 problems; do not default to the same score or a narrow clustered range for every entry, and do not template the reasoning sentences.
  - audience_resonance: how directly this problem's framing mirrors the audience's own language — draw specifically from language_problem, client_language_before, and pain_points. Higher score = closer to how they'd describe it themselves in their own words.
  - transformation_fit: how tightly solving this problem connects to the transformation data's after_state, the_bridge, and dream_outcome. Higher score = more directly on the path to what this coach's clients are already becoming.
  - conversion_ease: based on the audience's sales_objections already provided, how much resistance this specific problem's offer would likely face. Higher score = fewer or weaker objections apply, a smoother path to a yes.
  - monetization_potential: using the current business context (has_existing_offer, price, format, delivery). If they already have an offer, judge whether this problem maps to refining that existing offer (higher score, low friction) or would require building something from scratch (lower score, more effort) — reference the offer fit qualitatively in the reasoning sentence, do not invent a full new offer here. If they do NOT have an existing offer, score how clearly monetizable the problem/solution pairing is on its own.
- Do NOT compute or include an overall/average score — the app computes match_strength itself from the 4 scores.
- Do NOT include a suggested_offer object on top_10 entries — that is generated separately, only for the 3 finally selected problems.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function normalizeMatchFactor(raw: unknown): MatchFactor {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const n = typeof v.score === 'number' ? v.score : Number(v.score)
  const score = Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 5
  return { score, reasoning: typeof v.reasoning === 'string' ? v.reasoning : '' }
}

function normalizeMatchFactors(raw: unknown): MatchFactors {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    audience_resonance: normalizeMatchFactor(v.audience_resonance),
    transformation_fit: normalizeMatchFactor(v.transformation_fit),
    conversion_ease: normalizeMatchFactor(v.conversion_ease),
    monetization_potential: normalizeMatchFactor(v.monetization_potential),
  }
}

// One decimal place is plenty of resolution for a 1-10 average and avoids
// floating-point noise (e.g. 6.766666...) leaking into the sorted display.
function computeMatchStrength(f: MatchFactors): number {
  const sum = f.audience_resonance.score + f.transformation_fit.score + f.conversion_ease.score + f.monetization_potential.score
  return Math.round((sum / 4) * 10) / 10
}

export async function generateTop10(
  audience: unknown,
  transformation: unknown,
  intake: MatcherIntake,
  voiceContext?: string
): Promise<{ top_10: Top10Problem[]; recommended_ids: string[]; why_recommended: string; insights: string }> {
  const userMessage = `AUDIENCE INTELLIGENCE: ${JSON.stringify(audience)}
TRANSFORMATION DATA: ${JSON.stringify(transformation)}
CURRENT BUSINESS CONTEXT: ${JSON.stringify(intake)}
Generate the top 10 monetizable problems now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    // Was 4000 — too tight once match_factors added 4 scored sub-fields to
    // each of the 10 entries (confirmed truncating mid-response in production
    // on 2026-07-08). Raised to 6000 to match the other two one-shot
    // generators (transformationAnalysis, frameworkAnalysis), which sit at
    // 6000 for comparably-sized (or smaller-count) repeated structures.
    max_tokens: 6000,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${TOP_10_PROMPT}\n\n${voiceContext}` : TOP_10_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
  const parsed = extractJson(text)

  const rawTop10 = Array.isArray(parsed.top_10) ? parsed.top_10 : []
  const top_10: Top10Problem[] = rawTop10.map((p: any) => {
    const match_factors = normalizeMatchFactors(p?.match_factors)
    return {
      id: typeof p?.id === 'string' ? p.id : '',
      problem: typeof p?.problem === 'string' ? p.problem : '',
      reasoning: typeof p?.reasoning === 'string' ? p.reasoning : '',
      match_factors,
      match_strength: computeMatchStrength(match_factors),
    }
  })
  // Guaranteed display order regardless of what order the model emitted
  // entries in — never rely on the model's own ordering.
  top_10.sort((a, b) => b.match_strength - a.match_strength)

  return {
    top_10,
    recommended_ids: Array.isArray(parsed.recommended_ids) ? parsed.recommended_ids : [],
    why_recommended: typeof parsed.why_recommended === 'string' ? parsed.why_recommended : '',
    insights: typeof parsed.insights === 'string' ? parsed.insights : '',
  }
}

const SUGGESTED_OFFER_PROMPT = `You are given one specific monetizable problem a coach could build an offer around, and their current business context (whether they have an existing offer, and if so its price, format, and delivery). Produce a suggested offer for this problem.

If they do NOT currently have an offer: propose new packaging — a name, a format, and a price point that fits a coach at this stage.
If they DO have an existing offer: do not propose a competing new offer. Instead suggest a sharper angle on their EXISTING offer, positioned around this specific problem.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "name": "a name for the new offer, or null if suggesting an angle on an existing offer",
  "format": "the proposed format, or null if keeping their existing format",
  "price_point": "a suggested price point, or null if keeping their existing price",
  "angle_note": "if they have an existing offer: the sharper angle/positioning suggestion, specific to this problem. If proposing new packaging: a short note on why this packaging fits. Always populated, never null."
}
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

export async function generateSuggestedOffer(
  problem: Top10Problem,
  intake: MatcherIntake,
  voiceContext?: string
): Promise<SuggestedOffer> {
  const userMessage = `MONETIZABLE PROBLEM: ${JSON.stringify(problem)}
CURRENT BUSINESS CONTEXT: ${JSON.stringify(intake)}
Generate the suggested_offer now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 500,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${SUGGESTED_OFFER_PROMPT}\n\n${voiceContext}` : SUGGESTED_OFFER_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
  const parsed = extractJson(text)

  return {
    has_existing_offer: !!intake.has_existing_offer,
    name: typeof parsed.name === 'string' ? parsed.name : null,
    format: typeof parsed.format === 'string' ? parsed.format : null,
    price_point: typeof parsed.price_point === 'string' ? parsed.price_point : null,
    angle_note: typeof parsed.angle_note === 'string' ? parsed.angle_note : '',
  }
}
