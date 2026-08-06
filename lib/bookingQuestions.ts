import { supabase } from './supabase'
import { resolveLiveFunnel } from './funnels'

// Admin-defined custom questions for the public booking form. Stored as a JSON
// string in app_settings under the 'booking_questions' key (reusing the
// existing settings mechanism — least new code), managed by the admin UI.
// Name + email stay fixed fields on the form (needed for the Zoom meeting +
// confirmation); these are everything else.
//
// 'dropdown' and 'choice' are both single-select-from-a-list, same options:
// string[] shape and the same "must be one of them" validation — they differ
// only in how the public quiz renders them (a native <select> vs tappable
// option buttons). 'choice' is the one the Typeform-style application quiz
// wants: a coach's revenue-bracket or yes/no question reads as a real quiz
// question, not a form dropdown.
export type BookingQuestionType = 'single_line' | 'multi_line' | 'dropdown' | 'choice'

export type BookingQuestion = {
  id: string
  label: string
  type: BookingQuestionType
  required: boolean
  options?: string[]
  order: number
}

const VALID_TYPES: BookingQuestionType[] = ['single_line', 'multi_line', 'dropdown', 'choice']
// Both option-bearing types validate identically — see the type comment above.
const OPTION_TYPES: BookingQuestionType[] = ['dropdown', 'choice']

// Tolerant validator — malformed admin input is skipped rather than crashing
// the public booking form. Only well-formed question objects survive.
function isValidQuestion(v: unknown): v is BookingQuestion {
  if (!v || typeof v !== 'object') return false
  const q = v as Record<string, unknown>
  if (typeof q.id !== 'string' || !q.id.trim()) return false
  if (typeof q.label !== 'string' || !q.label.trim()) return false
  if (typeof q.type !== 'string' || !VALID_TYPES.includes(q.type as BookingQuestionType)) return false
  if (OPTION_TYPES.includes(q.type as BookingQuestionType)) {
    if (!Array.isArray(q.options) || q.options.length === 0 || !q.options.every((o) => typeof o === 'string' && o.trim())) {
      return false
    }
  }
  return true
}

// Normalize a raw array (from a jsonb column or a parsed JSON string) into
// validated, ordered questions. Malformed entries are skipped.
export function normalizeBookingQuestions(raw: unknown): BookingQuestion[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isValidQuestion)
    .map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required === true,
      ...(OPTION_TYPES.includes(q.type) ? { options: q.options as string[] } : {}),
      order: typeof q.order === 'number' ? q.order : 0,
    }))
    .sort((a, b) => a.order - b.order)
}

// ── Booking types ────────────────────────────────────────────────────────────
// Admin-defined labels for the booking-type dropdown on the public /book page,
// stored as a JSON string in app_settings under 'booking_types' — the same
// convention as booking_questions above, because app_settings.value is a text
// column and both write paths reject a value that is not a string. A sibling key
// with a second convention would be a trap for whoever touches it next.

/**
 * Tolerant normalizer: anything that is not an array of non-empty strings
 * becomes an empty list, and a malformed entry inside an otherwise good array is
 * skipped rather than throwing.
 *
 * Same stance as normalizeBookingQuestions, for the same reason. These labels
 * render on a public, unauthenticated page, so a fat-fingered admin save has to
 * degrade to "no type dropdown" — a visitor can still book. Throwing here would
 * turn one bad character in a settings field into a broken booking form for
 * every visitor, and nobody would connect the two.
 *
 * Accepts either a parsed array or the raw JSON string, so callers reading
 * straight from app_settings.value do not each need their own try/catch.
 */
export function normalizeBookingTypes(raw: unknown): string[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim())
}

/**
 * Load the booking-type labels. Returns [] when unset or malformed, never throws.
 *
 * Note the public /book page does NOT go through here — it reads the flat
 * unauthenticated GET /api/settings, which returns every stored row untouched.
 * That means the page normalizes the raw string itself, and the key is absent
 * from that response entirely until something has written it once. This exists
 * for server-side callers that need the parsed list.
 */
export async function loadBookingTypes(): Promise<string[]> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'booking_types')
    .maybeSingle()
  if (error || !data?.value) return []
  return normalizeBookingTypes(data.value)
}

// The reserved custom_answers entry the booking type is stored as.
//
// It rides in custom_answers rather than a column so every admin view that
// already renders answers renders it with no admin-side change — but it is
// accepted as a TOP-LEVEL request field, never as an answers-map key. The
// answers map is validated against admin-defined questions and the type is not
// one of those: validateBookingAnswers iterates the DEFINED questions and reads
// answersMap[q.id], so an unknown key is never read. A type sent inside answers
// is silently discarded, which is exactly what happened to booking
// 937c0f16 — the request carried four answers and the row stored three, with no
// error and no signal.
export const BOOKING_TYPE_ANSWER_ID = 'booking_type'
export const BOOKING_TYPE_LABEL = 'What kind of call is this?'

export type BookingTypeResolution =
  | { ok: true; entry: ValidatedAnswer | null }
  | { ok: false; error: string; message: string }

/**
 * Validate a submitted booking type against the configured list.
 *
 * ABSENCE IS ALWAYS ALLOWED, even when types ARE configured. Making it required
 * the moment an admin saves booking_types would break every booking made
 * between this deploy and the frontend's — the page currently sends the type
 * inside `answers`, where nothing reads it. A booking that loses its type is a
 * missing label; a booking that 400s is a lost lead.
 *
 * A SUPPLIED value must be one of the configured types. Matching is exact
 * first, then case-insensitive, and the CONFIGURED spelling is what gets
 * stored — so the value in the row always comes from the admin's list rather
 * than from whatever casing the client sent.
 *
 * With no types configured, a stray value is ignored rather than rejected:
 * absent configuration must not become a required field, and it must not become
 * a forbidden one either.
 */
export async function resolveBookingType(raw: unknown): Promise<BookingTypeResolution> {
  const configured = await loadBookingTypes()
  if (!configured.length) return { ok: true, entry: null }

  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { ok: true, entry: null }

  const match =
    configured.find((t) => t === value) ?? configured.find((t) => t.toLowerCase() === value.toLowerCase())
  if (!match) {
    return {
      ok: false,
      error: 'invalid_booking_type',
      message: `Please choose one of: ${configured.join(', ')}.`,
    }
  }

  return {
    ok: true,
    entry: { id: BOOKING_TYPE_ANSWER_ID, label: BOOKING_TYPE_LABEL, type: 'dropdown', answer: match },
  }
}

// Loads the GLOBAL active question definitions (legacy shared booking path).
// Returns [] when unset or malformed, never throws.
export async function loadBookingQuestions(): Promise<BookingQuestion[]> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'booking_questions')
    .maybeSingle()
  if (error || !data?.value || typeof data.value !== 'string') return []
  try {
    return normalizeBookingQuestions(JSON.parse(data.value))
  } catch {
    return []
  }
}

// Loads a FUNNEL's own booking questions from funnels.booking_questions (jsonb).
// Returns [] when the funnel is missing or the column is empty/malformed.
export async function loadFunnelBookingQuestions(funnelId: string): Promise<BookingQuestion[]> {
  const { data } = await supabase.from('funnels').select('booking_questions').eq('id', funnelId).maybeSingle()
  return normalizeBookingQuestions(data?.booking_questions)
}

export type ValidatedAnswer = { id: string; label: string; type: string; answer: string }

// Validate an answers map { [questionId]: value } against a set of questions and
// build the self-contained snapshot to store. Shared by both booking paths so the
// rules never drift. Same error codes the endpoint already returns.
export function validateBookingAnswers(
  questions: BookingQuestion[],
  answersMap: Record<string, unknown>
): { ok: true; answers: ValidatedAnswer[] } | { ok: false; error: string; question: string } {
  const out: ValidatedAnswer[] = []
  for (const q of questions) {
    const raw = answersMap[q.id]
    const answer = typeof raw === 'string' ? raw.trim() : raw != null ? String(raw).trim() : ''
    if (q.required && !answer) return { ok: false, error: 'question_required', question: q.label }
    if (OPTION_TYPES.includes(q.type) && answer && !(q.options || []).includes(answer)) {
      return { ok: false, error: 'invalid_option', question: q.label }
    }
    out.push({ id: q.id, label: q.label, type: q.type, answer })
  }
  return { ok: true, answers: out }
}

// ── Which questions actually apply to a booking ──────────────────────────────
// A FUNNEL's questions come from its own two settings and nothing else:
//   application_questions_enabled = false  -> no questions at all
//   application_questions_enabled = true   -> its booking_questions (may be [])
//
// The global app_settings set is for the LEGACY non-funnel booking page only. It
// is never a fallback for a funnel: falling back to it is what hard-blocked
// bookings on charge-demo, where the funnel has questions disabled but the global
// defaults (q_challenge / q_goal / q_revenue) were served and then validated
// against, so a lead was asked nothing and could never satisfy the check.
//
// Note this is deliberately independent of the calendar mode. An earlier revision
// only read the funnel's questions when the coach had Google connected, which left
// every native-calendar funnel on the global defaults — the same bug by a
// narrower route.
export function funnelBookingQuestions(funnelRow: Record<string, any>): BookingQuestion[] {
  // Strict === true: the column defaults to FALSE, and a missing/NULL value must
  // mean "off", matching the default rather than silently enabling questions.
  if (funnelRow.application_questions_enabled !== true) return []
  return normalizeBookingQuestions(funnelRow.booking_questions)
}

// Resolve the question set for a booking context. Both the public questions
// endpoint and the booking validator call this, so the set a lead is SHOWN and
// the set they are VALIDATED against are the same by construction.
export async function resolveBookingQuestions(funnelId?: string | null): Promise<BookingQuestion[]> {
  const id = typeof funnelId === 'string' ? funnelId.trim() : ''
  if (id) {
    const funnelRow = await resolveLiveFunnel({ funnelId: id })
    // A resolved funnel answers entirely from its own settings — never the global set.
    if (funnelRow) return funnelBookingQuestions(funnelRow)
  }
  // No funnel in play: the legacy shared booking page, unchanged.
  return loadBookingQuestions()
}

// Human-readable text for a validation failure, so a lead never sees a raw code.
export function bookingQuestionErrorMessage(error: string, question: string): string {
  switch (error) {
    case 'question_required':
      return `Please answer "${question}" to complete your booking.`
    case 'invalid_option':
      return `Please choose one of the listed options for "${question}".`
    default:
      return 'Please check your answers and try again.'
  }
}
