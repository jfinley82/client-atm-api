import { supabase } from './supabase'
import { WorkingHours, DayWindow, DEFAULT_WORKING_HOURS } from './availability'

// Load / validate a coach's per-account availability settings (user_availability).

export type AvailabilitySettings = {
  working_hours: WorkingHours
  slot_minutes: number
  buffer_minutes: number
  booking_window_days: number
}

export const DEFAULT_SETTINGS: AvailabilitySettings = {
  working_hours: DEFAULT_WORKING_HOURS,
  slot_minutes: 30,
  buffer_minutes: 15,
  booking_window_days: 14,
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const WH_KEYS = new Set<string>(['timezone', ...WEEKDAYS])
const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function toMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

// Validate one weekday window: null (day off) or { start, end } with valid HH:MM
// and end strictly after start.
function validateDay(v: unknown): { ok: true; value: DayWindow } | { ok: false } {
  if (v === null) return { ok: true, value: null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false }
  const o = v as Record<string, unknown>
  if (typeof o.start !== 'string' || typeof o.end !== 'string') return { ok: false }
  if (!HM_RE.test(o.start) || !HM_RE.test(o.end)) return { ok: false }
  if (toMinutes(o.end) <= toMinutes(o.start)) return { ok: false }
  return { ok: true, value: { start: o.start, end: o.end } }
}

// Validate a working_hours object. Own unknown keys are rejected. timezone is
// required and must be a real IANA zone.
export function validateWorkingHours(v: unknown): { ok: true; value: WorkingHours } | { ok: false; field: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, field: 'working_hours' }
  const o = v as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (!WH_KEYS.has(key)) return { ok: false, field: `working_hours.${key}` }
  }
  if (!isValidTimezone(o.timezone)) return { ok: false, field: 'working_hours.timezone' }
  const out: WorkingHours = { timezone: o.timezone as string }
  for (const day of WEEKDAYS) {
    if (day in o) {
      const r = validateDay(o[day])
      if (!r.ok) return { ok: false, field: `working_hours.${day}` }
      out[day] = r.value
    }
  }
  return { ok: true, value: out }
}

function intInRange(v: unknown, min: number, max: number): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null
  return n
}

// Validate a PUT body into a partial update. Only provided keys are updated
// (partial save); unknown top-level keys are rejected.
const ALLOWED_KEYS = new Set(['working_hours', 'slot_minutes', 'buffer_minutes', 'booking_window_days'])

export function validateSettingsInput(
  body: unknown
): { ok: true; update: Record<string, unknown> } | { ok: false; field: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body' }
  const o = body as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, field: key }
  }
  const update: Record<string, unknown> = {}
  if ('working_hours' in o) {
    const r = validateWorkingHours(o.working_hours)
    if (!r.ok) return { ok: false, field: r.field }
    update.working_hours = r.value
  }
  if ('slot_minutes' in o) {
    const n = intInRange(o.slot_minutes, 5, 240)
    if (n === null) return { ok: false, field: 'slot_minutes' }
    update.slot_minutes = n
  }
  if ('buffer_minutes' in o) {
    const n = intInRange(o.buffer_minutes, 0, 120)
    if (n === null) return { ok: false, field: 'buffer_minutes' }
    update.buffer_minutes = n
  }
  if ('booking_window_days' in o) {
    const n = intInRange(o.booking_window_days, 1, 90)
    if (n === null) return { ok: false, field: 'booking_window_days' }
    update.booking_window_days = n
  }
  if (Object.keys(update).length === 0) return { ok: false, field: 'body' }
  return { ok: true, update }
}

// Coerce a stored working_hours row into a WorkingHours (guarding a bad DB value).
function coerceWorkingHours(v: unknown): WorkingHours {
  const r = validateWorkingHours(v)
  return r.ok ? r.value : DEFAULT_WORKING_HOURS
}

export async function loadUserAvailability(userId: string): Promise<AvailabilitySettings> {
  const { data } = await supabase
    .from('user_availability')
    .select('working_hours, slot_minutes, buffer_minutes, booking_window_days')
    .eq('user_id', userId)
    .maybeSingle()

  if (!data) return DEFAULT_SETTINGS
  return {
    working_hours: coerceWorkingHours(data.working_hours),
    slot_minutes: intInRange(data.slot_minutes, 5, 240) ?? DEFAULT_SETTINGS.slot_minutes,
    buffer_minutes: intInRange(data.buffer_minutes, 0, 120) ?? DEFAULT_SETTINGS.buffer_minutes,
    booking_window_days: intInRange(data.booking_window_days, 1, 90) ?? DEFAULT_SETTINGS.booking_window_days,
  }
}
