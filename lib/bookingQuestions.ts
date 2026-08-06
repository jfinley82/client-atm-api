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

// A COACH's own booking-page questions. Same shape and validator as a funnel's,
// so the admin editor can be reused unchanged.
export async function loadCoachBookingQuestions(coachUserId: string): Promise<BookingQuestion[]> {
  const { data } = await supabase
    .from('funnel_business_settings')
    .select('booking_questions')
    .eq('user_id', coachUserId)
    .maybeSingle()
  return normalizeBookingQuestions((data as { booking_questions?: unknown } | null)?.booking_questions)
}

// Is the lead's phone required? Coach setting when there is a coach, the global
// app_settings key when there is not.
async function loadPhoneRequired(coachUserId: string | null): Promise<boolean> {
  if (coachUserId) {
    const { data } = await supabase
      .from('funnel_business_settings')
      .select('booking_phone_required')
      .eq('user_id', coachUserId)
      .maybeSingle()
    const v = (data as { booking_phone_required?: unknown } | null)?.booking_phone_required
    // Column default is true; only an explicit false turns it off, so a missing
    // row reads as required rather than as permission to skip.
    return v === false ? false : true
  }
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'booking_phone_required')
    .maybeSingle()
  const raw = (data as { value?: unknown } | null)?.value
  // THE GLOBAL KEY DEFAULTS TO NOT-REQUIRED WHEN ABSENT, unlike the coach
  // column, and the asymmetry is deliberate.
  //
  // The coach column defaults true and governs pages that do not exist yet — no
  // coach has a slug, so nothing can break. This key governs /book, which is
  // LIVE and does not collect a phone. Defaulting an unset key to required would
  // 400 every public booking from the moment this deploys until the frontend
  // ships the field: a booking that loses a phone number is a missing detail, a
  // booking that 400s is a lost lead. Same reasoning that keeps booking_type
  // optional.
  //
  // Once an admin saves the key it is honoured in both directions.
  if (typeof raw !== 'string' || !raw.trim()) return false
  return coerceBooleanSetting(raw)
}

// app_settings.value is TEXT, so the global toggle arrives as a string. A stored
// value that is not recognisably false counts as required — a malformed value
// must not quietly stop asking for the number once an admin has turned it on.
export function coerceBooleanSetting(v: unknown): boolean {
  if (typeof v !== 'string') return true
  return !/^(false|0|no|off)$/i.test(v.trim())
}

export type BookingRequirements = { questions: BookingQuestion[]; phoneRequired: boolean }

/**
 * Everything the booking FORM asks for, in one resolution.
 *
 * This is the extension of resolveBookingQuestions rather than a second
 * resolver, and the reason is the same one that function was built for: the set
 * a lead is SHOWN and the set they are VALIDATED against must be the same by
 * construction. A parallel path for phone would reintroduce exactly the drift —
 * a coach flips the toggle, the page stops showing an asterisk, and the server
 * keeps refusing.
 *
 * Questions and phone resolve from DIFFERENT places for a funnel booking, which
 * is deliberate:
 *   questions — the funnel's own, else the coach's, else the global MTM set.
 *   phone     — the COACH's, else the global setting.
 * A funnel's questions belong to that funnel's offer; whether the coach needs a
 * phone number is a fact about the coach, and it should not change depending on
 * which of their funnels a lead came through.
 *
 * A coach with no questions configured gets NONE. It never falls back to the
 * global set: those are MTM's own discovery-call questions and would appear on a
 * coach's page unasked.
 */
export async function resolveBookingRequirements(ctx: {
  funnelId?: string | null
  funnelRow?: Record<string, any> | null
  coachUserId?: string | null
}): Promise<BookingRequirements> {
  let funnelRow = ctx.funnelRow ?? null
  const id = typeof ctx.funnelId === 'string' ? ctx.funnelId.trim() : ''
  if (!funnelRow && id) funnelRow = await resolveLiveFunnel({ funnelId: id })

  const coachUserId = ctx.coachUserId ?? (funnelRow ? (funnelRow.user_id as string) : null)

  const questions = funnelRow
    ? funnelBookingQuestions(funnelRow)
    : coachUserId
      ? await loadCoachBookingQuestions(coachUserId)
      : await loadBookingQuestions()

  return { questions, phoneRequired: await loadPhoneRequired(coachUserId) }
}

// Back-compat wrapper for callers that only need the questions.
export async function resolveBookingQuestions(funnelId?: string | null): Promise<BookingQuestion[]> {
  return (await resolveBookingRequirements({ funnelId })).questions
}

/**
 * The lead's phone, loosely validated.
 *
 * People type spaces, dashes, brackets, dots and country codes, and no booking
 * should be refused over formatting — a lost lead costs more than a tidy string.
 * The only real checks are that it contains enough digits to be a number at all,
 * and not so many that it is something else.
 *
 * Stored as GIVEN, not reformatted: the coach is going to read it and dial it,
 * and a number rewritten into a shape its owner did not use is harder to
 * recognise, not easier.
 */
export function normalizeLeadPhone(raw: unknown): { ok: true; phone: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, phone: null }
  if (typeof raw !== 'string') return { ok: false }
  const phone = raw.trim()
  if (!phone) return { ok: true, phone: null }
  if (phone.length > 40) return { ok: false }
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return { ok: false }
  if (!/^[+()\-.\s\d]+$/.test(phone)) return { ok: false }
  return { ok: true, phone }
}

// Human-readable text for a validation failure, so a lead never sees a raw code.
export function bookingQuestionErrorMessage(error: string, question: string): string {
  switch (error) {
    case 'question_required':
      return `Please answer "${question}" to complete your booking.`
    case 'invalid_option':
      return `Please choose one of the listed options for "${question}".`
    case 'phone_required':
      return 'Please add a phone number so we can reach you.'
    case 'phone_invalid':
      return 'That phone number does not look right, please check it.'
    default:
      return 'Please check your answers and try again.'
  }
}
