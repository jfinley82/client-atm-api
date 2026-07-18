import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type BlueprintSynopsis = {
  solution_summary: string
  transformation: { before: string; after: string }
  offer_includes: string[]
  // null when the framework has no phases to fit against.
  framework_fit: { phase_index: number; phase_name: string; note: string } | null
  // One line on how this micro-training drives to the member's high-ticket
  // offer (call-or-direct). Empty string when no high-ticket offer is available
  // or it can't be generated.
  high_ticket_pitch: string
}

// The card fields the synopsis is grounded in — the validated blueprint's own
// problem/reasoning and its suggested_offer. No other card fields are used.
export type SynopsisCard = {
  card_name?: string
  problem_text: string
  reasoning: string
  suggested_offer: unknown
}

const SYNOPSIS_PROMPT = `You are given a coach's audience intelligence, their transformation data, their named results framework, and ONE validated problem/solution blueprint (its problem, the reasoning behind it, and a suggested offer). Write a tight synopsis of how this specific micro-training blueprint solves that problem.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "solution_summary": "2-3 sentences: how the micro-training solves this problem, grounded in this coach's specific data",
  "transformation": { "before": "one line — where the client is before", "after": "one line — where the client is after" },
  "offer_includes": ["2-4 concrete components of the suggested offer, in plain terms"],
  "framework_fit": { "phase_index": <integer>, "phase_name": "<exact name of that phase>", "note": "one line on how this problem is advanced in that phase" },
  "high_ticket_pitch": "one line: how THIS micro-training drives the viewer to the coach's HIGH-TICKET OFFER below"
}

Hard rules — follow exactly:
- Use ONLY the audience, transformation, framework, this blueprint's problem_text / reasoning / suggested_offer, and the HIGH-TICKET OFFER provided below. Introduce NO outside facts.
- high_ticket_pitch: ONE natural line on how this specific micro-training moves the viewer toward the high-ticket offer. Present BOTH paths — booking a coaching call from the video, or buying the offer directly — and lean toward whichever better fits the high-ticket offer's price point and delivery format. Ground it in the offer's actual name/price/format; invent no specifics. If NO high-ticket offer is provided below, return an empty string.
- offer_includes describes what is actually inside the suggested_offer (its name, format, price_point, angle_note) in plain terms. Do NOT invent components beyond what the suggested_offer and its angle_note imply. If the offer is thin, return FEWER items rather than padding to reach a count.
- framework_fit.phase_index MUST be one of the numbered framework phases listed below (the integer index). phase_name MUST be that phase's exact name as listed. Pick the phase this problem most directly advances.
- Every line must be specific to THIS coach's data — no generic coaching filler.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 4)
}

// Generates a per-blueprint synopsis grounded only in the passed data. Defensive
// like normalizeMatchFactor: malformed/missing fields degrade to null/empty and
// framework_fit is clamped to a real framework phase — never invents a phase and
// never throws on a malformed model response (a parse failure still throws
// GenerationParseError from extractJson, which callers treat as "leave synopsis
// null").
export async function generateBlueprintSynopsis(opts: {
  userId: string
  audience: unknown
  transformation: unknown
  framework: unknown
  card: SynopsisCard
  // The member's high-ticket core offer (at least name + price_point), so the
  // synopsis can pitch how this micro-training sells it. null/absent -> the
  // high_ticket_pitch degrades to an empty string.
  highTicket?: unknown
}): Promise<BlueprintSynopsis> {
  const phases = Array.isArray((opts.framework as { phases?: unknown })?.phases)
    ? ((opts.framework as { phases: Array<{ name?: unknown }> }).phases)
    : []
  const phaseNames = phases.map((p) => (typeof p?.name === 'string' ? p.name : ''))
  const phaseList = phaseNames.length
    ? phaseNames.map((n, i) => `${i}: ${n}`).join('\n')
    : '(no framework phases available — return framework_fit as null)'

  const userMessage = `AUDIENCE INTELLIGENCE: ${JSON.stringify(opts.audience)}
TRANSFORMATION DATA: ${JSON.stringify(opts.transformation)}
FRAMEWORK PHASES (use the integer index for phase_index):
${phaseList}
BLUEPRINT:
- problem_text: ${JSON.stringify(opts.card.problem_text)}
- reasoning: ${JSON.stringify(opts.card.reasoning)}
- suggested_offer: ${JSON.stringify(opts.card.suggested_offer)}
HIGH-TICKET OFFER: ${opts.highTicket ? JSON.stringify(opts.highTicket) : '(none — return high_ticket_pitch as an empty string)'}
Generate the synopsis now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 900,
    thinking: { type: 'disabled' },
    system: SYNOPSIS_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(opts.userId, 'blueprint_synopsis', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
  const parsed = extractJson(text)

  const t = (parsed?.transformation && typeof parsed.transformation === 'object' ? parsed.transformation : {}) as Record<string, unknown>

  // framework_fit: only valid when the framework actually has phases; clamp the
  // model's index into range and resolve the name from the framework itself so
  // it can never name a phase that doesn't exist.
  let framework_fit: BlueprintSynopsis['framework_fit'] = null
  if (phaseNames.length > 0) {
    const rawFit = (parsed?.framework_fit && typeof parsed.framework_fit === 'object' ? parsed.framework_fit : {}) as Record<string, unknown>
    const rawIdx = typeof rawFit.phase_index === 'number' ? rawFit.phase_index : Number(rawFit.phase_index)
    const idx = Number.isFinite(rawIdx) ? Math.min(phaseNames.length - 1, Math.max(0, Math.round(rawIdx))) : 0
    framework_fit = {
      phase_index: idx,
      phase_name: phaseNames[idx],
      note: typeof rawFit.note === 'string' ? rawFit.note : '',
    }
  }

  return {
    solution_summary: typeof parsed?.solution_summary === 'string' ? parsed.solution_summary : '',
    transformation: {
      before: typeof t.before === 'string' ? t.before : '',
      after: typeof t.after === 'string' ? t.after : '',
    },
    offer_includes: normalizeStringArray(parsed?.offer_includes),
    framework_fit,
    high_ticket_pitch: typeof parsed?.high_ticket_pitch === 'string' ? parsed.high_ticket_pitch : '',
  }
}
