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
  // A specific, hooky working title for the micro-training video ('' if not
  // generated), and 3-5 teaching beats the coach could deliver on camera —
  // the seed the full micro-training generation builds from.
  training_title: string
  teaching_outline: { point: string; detail: string }[]
  // Conviction layer — proof the problem is real, painful, and clears the path
  // to a sale. All '' when missing/ungenerated.
  audience_quote: string       // the problem in the audience's own words
  cost_of_inaction: string     // what this problem costs them left unsolved
  objection_dissolved: string  // the buyer objection this overcomes, + how
}

// The card fields the synopsis is grounded in — the validated blueprint's own
// problem/reasoning and its suggested_offer. No other card fields are used.
export type SynopsisCard = {
  card_name?: string
  problem_text: string
  reasoning: string
  suggested_offer: unknown
}

// The synopsis is generated in TWO parallel Anthropic calls that split the same
// field set across two smaller/faster requests (latency: wall-clock is the
// slower of the two, not the sum). Both calls share the identical grounding
// message and the same header/grounding rules; each carries ONLY its own
// fields' schema + per-field rules, copied verbatim from the single-call
// version. The union of the two schemas is exactly today's BlueprintSynopsis —
// no field is dropped, no rule is changed. Call A = positioning & offer; Call
// B = proof & teaching.

// Header shared by both calls: the framing sentence, the JSON-only instruction,
// the shared grounding rule, the "every line specific" rule, and the global
// gender-neutral + style guidelines. Every per-field rule lives in its own call.
const SHARED_HEADER = `You are given a coach's audience intelligence, their transformation data, their named results framework, and ONE validated problem/solution blueprint (its problem, the reasoning behind it, and a suggested offer). Write a tight synopsis of how this specific micro-training blueprint solves that problem.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.`

const SHARED_RULES = `- Use ONLY the audience, transformation, framework, this blueprint's problem_text / reasoning / suggested_offer, and the HIGH-TICKET OFFER provided below. Introduce NO outside facts.
- Every line must be specific to THIS coach's data — no generic coaching filler.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

// Call A — positioning & offer. solution_summary / transformation /
// offer_includes / framework_fit / high_ticket_pitch.
const SYNOPSIS_PROMPT_A = `${SHARED_HEADER}

{
  "solution_summary": "2-3 sentences: how the micro-training solves this problem, grounded in this coach's specific data",
  "transformation": { "before": "one line — where the client is before", "after": "one line — where the client is after" },
  "offer_includes": ["2-4 concrete components of the suggested offer, in plain terms"],
  "framework_fit": { "phase_index": <integer>, "phase_name": "<exact name of that phase>", "note": "one line on how this problem is advanced in that phase" },
  "high_ticket_pitch": "one line: how THIS micro-training drives the viewer to the coach's HIGH-TICKET OFFER below"
}

Hard rules — follow exactly:
- high_ticket_pitch: ONE natural line on how this specific micro-training moves the viewer toward the high-ticket offer. Present BOTH paths — booking a coaching call from the video, or buying the offer directly — and lean toward whichever better fits the high-ticket offer's price point and delivery format. Ground it in the offer's actual name/price/format; invent no specifics. If NO high-ticket offer is provided below, return an empty string.
- offer_includes describes what is actually inside the suggested_offer (its name, format, price_point, angle_note) in plain terms. Do NOT invent components beyond what the suggested_offer and its angle_note imply. If the offer is thin, return FEWER items rather than padding to reach a count.
- framework_fit.phase_index MUST be one of the numbered framework phases listed below (the integer index). phase_name MUST be that phase's exact name as listed. Pick the phase this problem most directly advances.
${SHARED_RULES}`

// Call B — proof & teaching. training_title / teaching_outline /
// audience_quote / cost_of_inaction / objection_dissolved.
const SYNOPSIS_PROMPT_B = `${SHARED_HEADER}

{
  "training_title": "a specific, hooky working title for this micro-training video",
  "teaching_outline": [ { "point": "the teaching beat", "detail": "one-line detail of what's taught in it" } ],
  "audience_quote": "the problem in the audience's OWN words, as they'd actually say it",
  "cost_of_inaction": "one line: what THIS problem costs them the longer it goes unsolved",
  "objection_dissolved": "the specific buyer objection this overcomes + one line on how the training answers it"
}

Hard rules — follow exactly:
- audience_quote: write it the way THIS audience would actually say it, drawn from the captured audience language (their language about the problem, their before-state wording, their internal dialogue / pain points). It must read like a real quote from their people — a sentence or two — never invented sentiment or marketing copy.
- cost_of_inaction: one line on what this SPECIFIC problem costs them the longer it stays unsolved — ground it in the transformation's stakes / cost-of-inaction data applied to this exact problem, not a generic "you'll fall behind" line.
- objection_dissolved: name a SPECIFIC buyer objection this problem/solution overcomes, drawn from the audience's stated sales objections, then one line on how this training answers it before it's even raised.
- training_title: a concrete, compelling working title/hook for THIS specific micro-training — grounded in this exact problem/solution, never a generic label. It should make the coach want to teach it.
- teaching_outline: 3 to 5 beats a coach could actually deliver on camera, ORDERED as they would be taught. Each has a short "point" (the beat) and a one-line "detail" of what's taught in it. Real teaching content specific to this problem/solution — no filler, no restating the title.
${SHARED_RULES}`

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 4)
}

function normalizeTeachingOutline(raw: unknown): { point: string; detail: string }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => (it && typeof it === 'object' ? (it as Record<string, unknown>) : {}))
    .filter((it) => typeof it.point === 'string' && (it.point as string).trim().length > 0)
    .map((it) => ({ point: it.point as string, detail: typeof it.detail === 'string' ? it.detail : '' }))
    .slice(0, 5)
}

// Runs one of the two synopsis calls and returns its parsed JSON object, or
// null if the call fails or its output won't parse. Isolating failure to a
// single call is what lets a partial outage keep the other half's fields
// instead of losing the whole synopsis. logApiCost still fires for a call whose
// output later fails to parse — the spend happened regardless — so both calls
// always produce a cost entry (two entries per regeneration).
async function runCall(
  userId: string,
  system: string,
  userMessage: string,
  label: string
): Promise<Record<string, unknown> | null> {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      // Half the field set per call, so ~half the single-call budget.
      max_tokens: 1200,
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: userMessage }],
    })

    await logApiCost(userId, 'blueprint_synopsis', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    return extractJson(text)
  } catch (err) {
    console.error('[blueprintSynopsis] call failed', label, err)
    return null
  }
}

// Generates a per-blueprint synopsis grounded only in the passed data. Runs two
// parallel calls (positioning/offer + proof/teaching) and merges them into one
// object identical in shape to the single-call version. Defensive like
// normalizeMatchFactor: malformed/missing fields degrade to null/empty and
// framework_fit is clamped to a real framework phase — never invents a phase.
// Partial failure degrades gracefully: if one call fails or won't parse, the
// other call's fields are kept and the failed call's fields fall back to their
// empty defaults. It throws only when BOTH calls fail (so the caller —
// resolveSynopsis — leaves the synopsis null and retries on the next read,
// rather than persisting an empty synopsis).
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

  // Both calls share this identical grounding block so each is working from the
  // exact same inputs.
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

  const [a, b] = await Promise.all([
    runCall(opts.userId, SYNOPSIS_PROMPT_A, userMessage, 'A:positioning'),
    runCall(opts.userId, SYNOPSIS_PROMPT_B, userMessage, 'B:proof'),
  ])

  // Only throw when we got nothing at all from either call — that's the case
  // resolveSynopsis treats as "leave synopsis null and retry next read". A
  // single-call failure is survivable and keeps the other half's fields.
  if (a === null && b === null) {
    throw new Error('[blueprintSynopsis] both synopsis calls failed')
  }

  const t = (a?.transformation && typeof a.transformation === 'object' ? a.transformation : {}) as Record<string, unknown>

  // framework_fit: only valid when the framework actually has phases AND Call A
  // (which owns this field) returned. Clamp the model's index into range and
  // resolve the name from the framework itself so it can never name a phase
  // that doesn't exist.
  let framework_fit: BlueprintSynopsis['framework_fit'] = null
  if (a !== null && phaseNames.length > 0) {
    const rawFit = (a?.framework_fit && typeof a.framework_fit === 'object' ? a.framework_fit : {}) as Record<string, unknown>
    const rawIdx = typeof rawFit.phase_index === 'number' ? rawFit.phase_index : Number(rawFit.phase_index)
    const idx = Number.isFinite(rawIdx) ? Math.min(phaseNames.length - 1, Math.max(0, Math.round(rawIdx))) : 0
    framework_fit = {
      phase_index: idx,
      phase_name: phaseNames[idx],
      note: typeof rawFit.note === 'string' ? rawFit.note : '',
    }
  }

  return {
    solution_summary: typeof a?.solution_summary === 'string' ? a.solution_summary : '',
    transformation: {
      before: typeof t.before === 'string' ? t.before : '',
      after: typeof t.after === 'string' ? t.after : '',
    },
    offer_includes: normalizeStringArray(a?.offer_includes),
    framework_fit,
    high_ticket_pitch: typeof a?.high_ticket_pitch === 'string' ? a.high_ticket_pitch : '',
    training_title: typeof b?.training_title === 'string' ? b.training_title : '',
    teaching_outline: normalizeTeachingOutline(b?.teaching_outline),
    audience_quote: typeof b?.audience_quote === 'string' ? b.audience_quote : '',
    cost_of_inaction: typeof b?.cost_of_inaction === 'string' ? b.cost_of_inaction : '',
    objection_dissolved: typeof b?.objection_dissolved === 'string' ? b.objection_dissolved : '',
  }
}
