import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type CoreOffer = {
  name: string
  price_point: string
  why_this_price: string
  whats_included: string
  delivery_format: string
  why_it_fits: string
  is_refinement: boolean
}

// The stored + returned shape. next_step_bridge is only present once
// confirmed — it does not exist until confirm (see
// api/matcher/core-offers/confirm.ts), and is a backend-computed constant,
// never model-generated (there is nothing dynamic to point to yet — My
// Micro-Trainings' actual assembly isn't built).
export type CoreOffersAnalysis = {
  low_ticket: CoreOffer
  high_ticket: CoreOffer
  confirmed: boolean
  next_step_bridge?: string
  // Upstream dependency timestamps as of confirmation — see lib/syncDependencies.ts.
  sync_snapshot?: Record<string, string>
}

// Placeholder forward-bridge line shown once core_offers is confirmed. Static
// today since there's nothing dynamic yet to reference; replace with real
// content once My Micro-Trainings' assembly exists.
export const NEXT_STEP_BRIDGE = 'Your full Micro-Training Blueprint is ready.'

const CORE_OFFERS_PROMPT = `You are an expert offer strategist and pricing consultant helping a coach design the two core offers their entire business runs on. This is the capstone of their process — you are given everything already established: their audience, their confirmed core transformation, their named results framework, their 3 finalized monetizable problem/solution blueprints, and their current business context (whether they already sell something).

Design exactly two offers:
- low_ticket: an entry-point offer that monetizes top-of-funnel traffic — built from the 3 finalized blueprints (a specific problem/solution pairing a prospect can say yes to quickly, low friction, low price).
- high_ticket: their main coaching program — built from the core CONFIRMED TRANSFORMATION and RESULTS FRAMEWORK (the full, named delivery method, the premium offer this coach is really known for).

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "low_ticket": {
    "name": "a specific, sellable name for this offer",
    "price_point": "a specific price or price range",
    "why_this_price": "grounded, specific reasoning for this price — cite an actual signal from this coach's data, not generic market-rate language",
    "whats_included": "what the buyer actually gets — concrete and specific",
    "delivery_format": "how it's delivered (self-paced, live cohort, 1:1, async, etc.)",
    "why_it_fits": "why this specific offer fits this specific coach and audience, grounded in their data",
    "is_refinement": true or false
  },
  "high_ticket": { same 7 fields, describing the main coaching program },
  "confirmed": false
}

Rules:
- low_ticket must be built from the 3 finalized blueprints provided (FINALIZED BLUEPRINTS below) — a specific, monetizable entry point drawn from that problem/solution work, not a generic "starter offer."
- high_ticket must be built from the CONFIRMED TRANSFORMATION and RESULTS FRAMEWORK provided — their signature, named delivery method, positioned as the premium program.
- high_ticket price_point MUST be at least $3,000 — a genuine premium price for their signature coaching program. It may be a single figure or a range, but the low end must be $3,000 or higher. low_ticket has NO such floor — it is the low-risk entry offer, priced accordingly.
- CURRENT BUSINESS CONTEXT tells you whether this coach already sells something (has_existing_offer), and if so its price/format/delivery. Decide which of the two offers (if either) that existing offer maps to — compare its price/format against what a real top-of-funnel entry offer looks like versus a real core program. Set is_refinement: true on THAT ONE offer only; the other stays is_refinement: false. If they have no existing offer, both are is_refinement: false.
- For whichever offer has is_refinement: true, why_this_price and why_it_fits must be framed as SHARPENING the coach's existing offer — keep its price/format/delivery unless there is a specific, grounded reason from their data to adjust it, and never invent a competing new offer to sit alongside what they already sell. This is the same non-competing-offer principle already used for the per-blueprint suggested offers.
- why_this_price must cite a specific signal from THIS member's own data — a price-sensitivity or willingness-to-pay signal from their audience (e.g. a sales objection about cost, a stated budget reality, language about what they can afford), not a generic "market rate for this niche" statement.
- why_it_fits must cite the specific proven weight of their transformation or blueprint work (e.g. a proof point, a specific result, a specific problem/outcome pairing) — not abstract positioning advice.
- Do not invent data not present in what you were given. Ground every field in specifics from the audience, transformation, framework, blueprints, or business context provided.
- confirmed is always false in this output — it is set later by the member.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// The high_ticket is the premium program the whole model sells, so it has a
// hard $3,000 floor. The prompt asks for >= $3,000, but a model can still come
// in low (a live account generated ~$2,000), so this is a defensive backstop:
// parse the first number out of the price_point (handling a "k" suffix and
// commas); if it's below the floor or unparseable, clamp the displayed figure
// up rather than ship a sub-floor number. Never throws — the member can still
// edit the price at the confirm step.
const HIGH_TICKET_FLOOR = 3000

function enforceHighTicketFloor(offer: CoreOffer): CoreOffer {
  const cleaned = offer.price_point.replace(/,/g, '')
  const m = cleaned.match(/(\d+(?:\.\d+)?)\s*([kK])?/)
  let first = m ? parseFloat(m[1]) : NaN
  if (m && m[2]) first *= 1000 // "$3.5k" -> 3500
  if (Number.isFinite(first) && first >= HIGH_TICKET_FLOOR) return offer
  return { ...offer, price_point: '$3,000' }
}

function coerceOffer(raw: unknown): CoreOffer {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    name: asString(o.name),
    price_point: asString(o.price_point),
    why_this_price: asString(o.why_this_price),
    whats_included: asString(o.whats_included),
    delivery_format: asString(o.delivery_format),
    why_it_fits: asString(o.why_it_fits),
    is_refinement: o.is_refinement === true,
  }
}

export async function generateCoreOffers(
  userId: string,
  audience: unknown,
  confirmedTransformation: unknown,
  confirmedFramework: unknown,
  finalizedBlueprints: unknown,
  intake: unknown,
  voiceContext?: string
): Promise<{ low_ticket: CoreOffer; high_ticket: CoreOffer }> {
  const userMessage = `AUDIENCE DATA: ${JSON.stringify(audience)}

CONFIRMED TRANSFORMATION: ${JSON.stringify(confirmedTransformation)}

RESULTS FRAMEWORK: ${JSON.stringify(confirmedFramework)}

FINALIZED BLUEPRINTS: ${JSON.stringify(finalizedBlueprints)}

CURRENT BUSINESS CONTEXT: ${JSON.stringify(intake)}

Generate the two core offers now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 3000,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${CORE_OFFERS_PROMPT}\n\n${voiceContext}` : CORE_OFFERS_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(userId, 'core_offers', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  // find(), not content[0] — matches the defensive pattern used across this
  // app so a future thinking-mode change doesn't silently break parsing.
  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  const parsed = extractJson(text)

  return {
    low_ticket: coerceOffer(parsed.low_ticket),
    high_ticket: enforceHighTicketFloor(coerceOffer(parsed.high_ticket)),
  }
}
