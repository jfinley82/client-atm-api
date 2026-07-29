import { BookingQuestion } from './bookingQuestions'

// ── Application gate ─────────────────────────────────────────────────────────
// When a funnel has application_questions_enabled, the public booking page runs
// in two steps: the questions first, the calendar only after the answers pass.
// This module owns the rule evaluation and the resulting screen state, so the
// server-rendered page and the submit endpoint decide identically — the same
// shared-source discipline the slot list/validator pair now follows.

export const DISQUALIFY_ACTIONS = ['message', 'resource', 'redirect', 'ai_assistant', 'block', 'flag'] as const
export type DisqualifyAction = (typeof DISQUALIFY_ACTIONS)[number]

export const RULE_OPERATORS = ['equals', 'not_equals', 'contains', 'in', 'not_in', 'lt', 'gt'] as const
export type RuleOperator = (typeof RULE_OPERATORS)[number]

// A rule DISQUALIFIES when it matches. Rules are OR'd: any hit is a no-fit.
export type DisqualifyRule = { question_id: string; operator: RuleOperator; value: unknown }

function isOperator(v: unknown): v is RuleOperator {
  return typeof v === 'string' && (RULE_OPERATORS as readonly string[]).includes(v)
}

// Tolerant normalizer, mirroring normalizeBookingQuestions: a malformed rule is
// dropped rather than crashing the public page or, worse, silently disqualifying
// everyone. Storing only well-formed rules means evaluation never has to guess.
export function normalizeDisqualifyRules(raw: unknown): DisqualifyRule[] {
  if (!Array.isArray(raw)) return []
  const out: DisqualifyRule[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const qid = typeof o.question_id === 'string' ? o.question_id.trim() : ''
    if (!qid || !isOperator(o.operator)) continue
    out.push({ question_id: qid, operator: o.operator, value: o.value })
  }
  return out
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().toLowerCase()
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(asText) : asText(v) ? [asText(v)] : [])
const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  // Tolerate money-ish answers ("$5,000") so a numeric rule works on a text field.
  const stripped = String(v ?? '').replace(/[^0-9.-]/g, '')
  // MUST bail on empty BEFORE Number(): Number('') is 0, not NaN, so a blank or
  // unanswered question would read as zero and trip any `lt` rule — silently
  // disqualifying every lead who skipped the question. The gate rejects on
  // evidence, never on absence.
  if (stripped.trim().length === 0) return null
  const n = Number(stripped)
  return Number.isFinite(n) ? n : null
}

// Does this single rule trip on the lead's answer?
export function ruleTrips(rule: DisqualifyRule, answer: unknown): boolean {
  const a = asText(answer)
  switch (rule.operator) {
    case 'equals':
      return a === asText(rule.value)
    case 'not_equals':
      // An unanswered question is not evidence of a mismatch, so a blank answer
      // never trips not_equals — otherwise skipping an optional question would
      // silently disqualify.
      return a !== '' && a !== asText(rule.value)
    case 'contains':
      return a !== '' && a.includes(asText(rule.value))
    case 'in':
      return a !== '' && asList(rule.value).includes(a)
    case 'not_in':
      return a !== '' && !asList(rule.value).includes(a)
    case 'lt': {
      const l = asNumber(answer)
      const r = asNumber(rule.value)
      return l !== null && r !== null && l < r
    }
    case 'gt': {
      const l = asNumber(answer)
      const r = asNumber(rule.value)
      return l !== null && r !== null && l > r
    }
    default:
      return false
  }
}

export type GateOutcome =
  | { qualified: true }
  | { qualified: false; action: DisqualifyAction; message: string; redirect_url: string | null; rule: DisqualifyRule }

export type FunnelGateConfig = {
  disqualify_rules?: unknown
  disqualify_action?: unknown
  disqualify_message?: unknown
  disqualify_redirect_url?: unknown
}

const DEFAULT_DISQUALIFY_MESSAGE = "Thanks for your interest — this isn't the right fit right now."

// Evaluate a lead's answers against the funnel's rules.
//
// Rules reference question ids, so an answers map keyed by question id is what
// gets passed in. A rule whose question was never answered simply does not trip
// (see the blank-answer handling above) — the gate rejects on evidence, never on
// absence, because a false disqualification silently destroys a real lead.
export function evaluateGate(
  funnel: FunnelGateConfig,
  answersById: Record<string, unknown>
): GateOutcome {
  const rules = normalizeDisqualifyRules(funnel.disqualify_rules)
  for (const rule of rules) {
    if (ruleTrips(rule, answersById[rule.question_id])) {
      const rawAction = typeof funnel.disqualify_action === 'string' ? funnel.disqualify_action : 'message'
      // Legacy values from migration 012 ('block'/'flag') predate the gate's
      // screen states; both mean "stop here with a message".
      const action: DisqualifyAction = (DISQUALIFY_ACTIONS as readonly string[]).includes(rawAction)
        ? (rawAction as DisqualifyAction)
        : 'message'
      const message =
        typeof funnel.disqualify_message === 'string' && funnel.disqualify_message.trim().length > 0
          ? funnel.disqualify_message.trim()
          : DEFAULT_DISQUALIFY_MESSAGE
      const redirect =
        typeof funnel.disqualify_redirect_url === 'string' && funnel.disqualify_redirect_url.trim().length > 0
          ? funnel.disqualify_redirect_url.trim()
          : null
      return { qualified: false, action, message, redirect_url: redirect, rule }
    }
  }
  return { qualified: true }
}

// Is the gate switched on for this funnel AND does it actually have questions?
// Enabled with zero questions is a no-op gate, not an empty quiz screen.
export function gateApplies(funnel: { application_questions_enabled?: unknown }, questions: BookingQuestion[]): boolean {
  return funnel.application_questions_enabled === true && questions.length > 0
}

// THE entry point for every surface that has to honour the gate: the public
// application endpoint, and both booking paths in api/calendar/book.ts.
//
// The booking handler has to re-check rather than trust the page, because a
// disqualified lead must NEVER be written as a booking — and a POST straight to
// /api/calendar/book bypasses the page entirely. Calling the same function there
// is what makes the client-side screen a convenience rather than the enforcement.
//
// A funnel with the gate off (or no questions) qualifies everyone, so callers can
// invoke this unconditionally.
export function checkGate(
  funnel: FunnelGateConfig & { application_questions_enabled?: unknown },
  questions: BookingQuestion[],
  answersById: Record<string, unknown>
): GateOutcome {
  if (!gateApplies(funnel, questions)) return { qualified: true }
  return evaluateGate(funnel, answersById)
}
