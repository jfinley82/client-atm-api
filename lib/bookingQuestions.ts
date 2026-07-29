import { supabase } from './supabase'
import { resolveLiveFunnel } from './funnels'

// Admin-defined custom questions for the public booking form. Stored as a JSON
// string in app_settings under the 'booking_questions' key (reusing the
// existing settings mechanism — least new code), managed by the admin UI.
// Name + email stay fixed fields on the form (needed for the Zoom meeting +
// confirmation); these are everything else.
export type BookingQuestionType = 'single_line' | 'multi_line' | 'dropdown'

export type BookingQuestion = {
  id: string
  label: string
  type: BookingQuestionType
  required: boolean
  options?: string[]
  order: number
}

const VALID_TYPES: BookingQuestionType[] = ['single_line', 'multi_line', 'dropdown']

// Tolerant validator — malformed admin input is skipped rather than crashing
// the public booking form. Only well-formed question objects survive.
function isValidQuestion(v: unknown): v is BookingQuestion {
  if (!v || typeof v !== 'object') return false
  const q = v as Record<string, unknown>
  if (typeof q.id !== 'string' || !q.id.trim()) return false
  if (typeof q.label !== 'string' || !q.label.trim()) return false
  if (typeof q.type !== 'string' || !VALID_TYPES.includes(q.type as BookingQuestionType)) return false
  if (q.type === 'dropdown') {
    if (!Array.isArray(q.options) || !q.options.every((o) => typeof o === 'string')) return false
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
      ...(q.type === 'dropdown' ? { options: q.options as string[] } : {}),
      order: typeof q.order === 'number' ? q.order : 0,
    }))
    .sort((a, b) => a.order - b.order)
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
    if (q.type === 'dropdown' && answer && !(q.options || []).includes(answer)) {
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
