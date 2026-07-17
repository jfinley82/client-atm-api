import { supabase } from './supabase'

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

// Loads the active question definitions, ordered. Returns [] when unset or
// malformed (the booking form simply shows no custom questions), never throws.
export async function loadBookingQuestions(): Promise<BookingQuestion[]> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'booking_questions')
    .maybeSingle()
  if (error || !data?.value || typeof data.value !== 'string') return []

  try {
    const parsed = JSON.parse(data.value)
    if (!Array.isArray(parsed)) return []
    return parsed
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
  } catch {
    return []
  }
}
