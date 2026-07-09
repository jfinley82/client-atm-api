import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type WeeklyBreakdownEntry = {
  week: number
  phase_name: string
  session_focus: string
  client_milestone: string
}

// The stored + returned shape. suggested_starting_price is deterministically
// overridden to core_offers.high_ticket.price_point verbatim after generation
// (see api/toolkits/program/analyze.ts) — never trusted to the model's own
// paraphrasing, the same principle as PHASE_COLORS/resolveFrameworkName/
// match_strength being backend-computed rather than model-generated.
export type ProgramAnalysis = {
  program_name: string
  session_type: string
  total_weeks: number
  total_sessions: number
  session_length_minutes: number
  timeline_reasoning: string
  weekly_breakdown: WeeklyBreakdownEntry[]
  deliverables: string[]
  suggested_starting_price: string
  suggested_capacity_per_month: number
  confirmed: boolean
  // Upstream dependency timestamps as of confirmation — see lib/syncDependencies.ts.
  sync_snapshot?: Record<string, string>
}

const PROGRAM_PROMPT = `You are an expert program designer helping a coach turn their confirmed high-ticket core offer into an actual sellable program — a real session structure a client could enroll in tomorrow.

You are given: the coach's CONFIRMED high-ticket core offer (name, price, what's included, delivery format), their named results FRAMEWORK (the phases and steps their method actually walks a client through), and their audience data. Ground everything in this specific data — the weekly breakdown must be a real mapping of the framework's actual phases and steps onto a calendar, not a generic coaching-program template.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "program_name": "a specific, sellable name for this program — may echo or extend the framework name",
  "session_type": "1:1 Coaching, Group Program, or Hybrid — pick whichever best fits the core offer's delivery_format",
  "total_weeks": <integer, 4-16>,
  "total_sessions": <integer>,
  "session_length_minutes": <integer, typically 30-90>,
  "timeline_reasoning": "why this length and session count fits — reference the framework's actual phase/step count and the offer's delivery format",
  "weekly_breakdown": [
    { "week": 1, "phase_name": "must be one of the framework's actual phase names", "session_focus": "what this specific week's session covers, grounded in a real step from that phase", "client_milestone": "the tangible shift the client has after this week" }
  ],
  "deliverables": ["a specific, concrete thing the client receives", "a second distinct deliverable", "a third", "a fourth"],
  "suggested_starting_price": "echo the core offer's price_point here — it will be verified/overridden by the app regardless",
  "suggested_capacity_per_month": <integer, a reasonable starting assumption for how many clients this coach could realistically take on per month at this offer>,
  "confirmed": false
}

Rules:
- weekly_breakdown must have EXACTLY total_weeks entries, one per week, numbered 1 through total_weeks in order.
- Every phase_name in weekly_breakdown must be an EXACT match to one of the framework's actual phase names provided — never invent a phase. Distribute the weeks across the phases in the order the client actually moves through them (framework phase order), weighted toward phases with more steps.
- session_focus fields must be grounded in the framework's actual steps for that phase — do not write generic "check-in call" filler weeks.
- deliverables must have 4 to 6 entries, each a concrete, specific thing grounded in the framework's steps or the core offer's whats_included — not generic coaching-industry boilerplate.
- Do NOT compute or include a revenue forecast — the app computes that from price × capacity, client-side, never from your output.
- Ground every field in the specific data provided. No generic coaching-industry platitudes.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function coerceWeeklyEntry(raw: unknown, fallbackWeek: number): WeeklyBreakdownEntry {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const week = typeof o.week === 'number' && Number.isFinite(o.week) ? o.week : fallbackWeek
  return {
    week,
    phase_name: asString(o.phase_name),
    session_focus: asString(o.session_focus),
    client_milestone: asString(o.client_milestone),
  }
}

export async function generateProgram(
  userId: string,
  highTicketOffer: unknown,
  framework: unknown,
  audience: unknown,
  voiceContext?: string
): Promise<Omit<ProgramAnalysis, 'confirmed'>> {
  const userMessage = `CONFIRMED HIGH-TICKET CORE OFFER: ${JSON.stringify(highTicketOffer)}

RESULTS FRAMEWORK: ${JSON.stringify(framework)}

AUDIENCE DATA: ${JSON.stringify(audience)}

Generate the program now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${PROGRAM_PROMPT}\n\n${voiceContext}` : PROGRAM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(userId, 'program', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  const parsed = extractJson(text)

  const rawBreakdown = Array.isArray(parsed.weekly_breakdown) ? parsed.weekly_breakdown : []
  const weekly_breakdown = rawBreakdown.map((entry: unknown, i: number) => coerceWeeklyEntry(entry, i + 1))

  const totalWeeksRaw = Number(parsed.total_weeks)
  const totalSessionsRaw = Number(parsed.total_sessions)
  const sessionLengthRaw = Number(parsed.session_length_minutes)
  const capacityRaw = Number(parsed.suggested_capacity_per_month)

  return {
    program_name: asString(parsed.program_name),
    session_type: asString(parsed.session_type),
    total_weeks: Number.isFinite(totalWeeksRaw) && totalWeeksRaw > 0 ? Math.round(totalWeeksRaw) : weekly_breakdown.length,
    total_sessions: Number.isFinite(totalSessionsRaw) && totalSessionsRaw > 0 ? Math.round(totalSessionsRaw) : weekly_breakdown.length,
    session_length_minutes: Number.isFinite(sessionLengthRaw) && sessionLengthRaw > 0 ? Math.round(sessionLengthRaw) : 60,
    timeline_reasoning: asString(parsed.timeline_reasoning),
    weekly_breakdown,
    deliverables: Array.isArray(parsed.deliverables)
      ? parsed.deliverables.filter((d: unknown): d is string => typeof d === 'string')
      : [],
    suggested_starting_price: asString(parsed.suggested_starting_price),
    suggested_capacity_per_month: Number.isFinite(capacityRaw) && capacityRaw > 0 ? Math.round(capacityRaw) : 6,
  }
}
