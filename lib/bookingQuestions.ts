import { supabase } from './supabase'
import { resolveLiveFunnel } from './funnels'
import { getValidAccessToken } from './googleCalendar'

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
// /api/calendar/book picks its path from (funnel resolves && owner has Google):
// the FUNNEL path validates against the funnel's own questions, the LEGACY path
// against the global admin set. The public booking page must render exactly the
// set that will be validated, or a lead sees `question_required` for a field that
// was never on the form — which is precisely the live bug this resolves.
//
// Both the page (/api/calendar/questions) and the validator now call THIS, so the
// two agree by construction rather than by two copies of the same condition.
export async function resolveBookingQuestions(funnelId?: string | null): Promise<BookingQuestion[]> {
  const id = typeof funnelId === 'string' ? funnelId.trim() : ''
  if (id) {
    const funnelRow = await resolveLiveFunnel({ funnelId: id })
    if (funnelRow) {
      const conn = await getValidAccessToken(funnelRow.user_id as string)
      // Funnel path — the funnel's own questions (defaults to [], i.e. none).
      if (conn) return loadFunnelBookingQuestions(funnelRow.id as string)
    }
  }
  // Legacy shared path — the global admin question set.
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
