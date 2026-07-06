import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type MatcherIntake = {
  has_existing_offer: boolean
  price?: string
  format?: string
  delivery?: string
}

export type Top10Problem = {
  id: string
  problem: string
  reasoning: string
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

function extractJson(text: string): any {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  return JSON.parse(cleaned)
}

const TOP_10_PROMPT = `You are an expert offer strategist for coaches. You are given a coach's complete audience intelligence, their transformation data, and their current business context. Identify the 10 most monetizable problems this specific coach could build a paid offer around — grounded in THEIR audience and transformation data, not generic coaching advice.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "top_10": [
    { "id": "p1", "problem": "a specific, monetizable problem statement", "reasoning": "connect one specific detail from the audience intelligence to one specific detail from the transformation data by name — do not speak generically" }
  ],
  "recommended_ids": ["p_", "p_", "p_"],
  "why_recommended": "a specific explanation of why these 3 beat the other 7, referencing specifics from the data",
  "insights": "a specific pattern or connection across the audience and transformation data the coach has likely not connected themselves — not a summary of what they already said"
}

Rules:
- top_10 must have exactly 10 entries, ids "p1" through "p10", each a genuinely distinct problem — not 10 rephrasings of the same idea.
- Ground every reasoning field in specifics from the data provided (e.g. real_problem, internal_dialogue, tried_before, the_bridge, proof_point) — name what you are drawing from, do not speak in generalities.
- recommended_ids must have exactly 3 ids, chosen for being felt urgently, addressable by this coach's specific transformation capability, and likely to create natural demand for more help.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

export async function generateTop10(
  audience: unknown,
  transformation: unknown,
  intake: MatcherIntake
): Promise<{ top_10: Top10Problem[]; recommended_ids: string[]; why_recommended: string; insights: string }> {
  const userMessage = `AUDIENCE INTELLIGENCE: ${JSON.stringify(audience)}
TRANSFORMATION DATA: ${JSON.stringify(transformation)}
CURRENT BUSINESS CONTEXT: ${JSON.stringify(intake)}
Generate the top 10 monetizable problems now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    thinking: { type: 'disabled' },
    system: TOP_10_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
  const parsed = extractJson(text)

  return {
    top_10: Array.isArray(parsed.top_10) ? parsed.top_10 : [],
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

export async function generateSuggestedOffer(problem: Top10Problem, intake: MatcherIntake): Promise<SuggestedOffer> {
  const userMessage = `MONETIZABLE PROBLEM: ${JSON.stringify(problem)}
CURRENT BUSINESS CONTEXT: ${JSON.stringify(intake)}
Generate the suggested_offer now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 500,
    thinking: { type: 'disabled' },
    system: SUGGESTED_OFFER_PROMPT,
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
