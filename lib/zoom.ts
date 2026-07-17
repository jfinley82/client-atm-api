// Zoom Server-to-Server OAuth + Meetings/Scheduler helpers. All Zoom calls go
// through here so credentials never leave the backend — the browser only ever
// calls our own /api/calendar/* endpoints.
//
// Path chosen (see the sprint recon): availability is READ from Zoom Scheduler
// (so the calendar honors the host's real working hours/buffers); the meeting
// itself is CREATED via the Meetings API (reliable server-side create); we
// send the confirmation ourselves. The Scheduler server-side booking-create
// flow was too new/unsettled to bet the build on.

const SLOT_MINUTES = Number(process.env.ZOOM_SLOT_MINUTES) || 30

export function isZoomConfigured(): boolean {
  return !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET)
}

export function slotMinutes(): number {
  return SLOT_MINUTES
}

// Cached account-level access token. S2S tokens live ~1h; cache in module
// scope (per warm lambda instance) and refresh a minute before expiry.
let cachedToken: { token: string; expiresAt: number } | null = null

export async function getZoomToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token

  const basic = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64')
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID!)}`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`zoom token request failed ${res.status}: ${body}`)
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number }
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 }
  return cachedToken.token
}

async function zoomFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getZoomToken()
  return fetch(`https://api.zoom.us/v2${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  })
}

export type Slot = { start: string; end: string } // both UTC ISO

// Reads open slots from the host's Scheduler schedule for [from, to] (ISO
// dates/datetimes). The available_times endpoint is new (released 2026-07-13)
// and its exact response shape couldn't be confirmed from the docs (Zoom's
// dev-docs 403 automated fetches), so parsing is defensive: it accepts the
// documented key plus a couple of likely field-name variants and logs the raw
// keys if none match, so the first live response reveals any needed tweak
// rather than silently returning empty. end is computed from SLOT_MINUTES when
// the response doesn't carry one.
export async function getSchedulerAvailability(fromISO: string, toISO: string): Promise<Slot[]> {
  const scheduleId = process.env.ZOOM_SCHEDULE_ID
  if (!scheduleId) throw new Error('ZOOM_SCHEDULE_ID not set')

  const qs = new URLSearchParams({ from: fromISO, to: toISO }).toString()
  const res = await zoomFetch(`/scheduler/schedules/${encodeURIComponent(scheduleId)}/available_times?${qs}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`zoom availability failed ${res.status}: ${body}`)
  }
  const data = (await res.json()) as Record<string, unknown>

  const rawList =
    (Array.isArray(data.items) && data.items) ||
    (Array.isArray(data.available_times) && data.available_times) ||
    (Array.isArray(data.availableTimes) && data.availableTimes) ||
    (Array.isArray(data.slots) && data.slots) ||
    (Array.isArray(data.available_slots) && data.available_slots) ||
    null

  if (!rawList) {
    console.error('[zoom] availability response shape unrecognized — keys:', Object.keys(data))
    return []
  }

  const slots: Slot[] = []
  for (const item of rawList as Array<Record<string, unknown>>) {
    const start =
      (typeof item.start_time === 'string' && item.start_time) ||
      (typeof item.start === 'string' && item.start) ||
      (typeof item === 'string' && item) ||
      null
    if (!start) continue
    const startMs = new Date(start).getTime()
    if (Number.isNaN(startMs)) continue
    const endRaw =
      (typeof item.end_time === 'string' && item.end_time) || (typeof item.end === 'string' && item.end) || null
    const end = endRaw ?? new Date(startMs + SLOT_MINUTES * 60_000).toISOString()
    slots.push({ start: new Date(startMs).toISOString(), end: new Date(end).toISOString() })
  }
  return slots
}

// Lists the account's Zoom Scheduler schedules (id + name) so an admin can
// find the scheduleId to configure ZOOM_SCHEDULE_ID with. Needs the
// scheduler:read:list_schedules:admin scope on the app. Response shape is
// parsed defensively — this Scheduler endpoint's exact fields couldn't be
// confirmed from the docs (they 403 automated fetches), so it accepts the
// likely key/field variants and logs raw keys if none match.
// TEMPORARY: returns the raw schedule objects (all fields) instead of mapping
// to {id, name} — the name/title mapping came back empty, so this exposes the
// real field names (likely slug/topic/duration/etc.) to identify the right
// schedule and the correct id field. Revert to the {id, name} mapping once the
// field names are confirmed.
export async function listSchedules(): Promise<Array<Record<string, unknown>>> {
  const res = await zoomFetch('/scheduler/schedules')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`zoom list schedules failed ${res.status}: ${body}`)
  }
  const data = (await res.json()) as Record<string, unknown>
  const rawList =
    (Array.isArray(data.items) && data.items) ||
    (Array.isArray(data.schedules) && data.schedules) ||
    (Array.isArray(data.data) && data.data) ||
    null
  if (!rawList) {
    console.error('[zoom] list schedules response shape unrecognized — keys:', Object.keys(data))
    return []
  }
  return rawList as Array<Record<string, unknown>>
}

// Creates a scheduled Zoom meeting at the chosen UTC start. Host defaults to
// the account owner ('me' resolves to the S2S app owner); override with
// ZOOM_HOST_EMAIL to book on a specific user. Returns the fields the booking
// row and the customer confirmation need.
export async function createZoomMeeting(topic: string, startUtcISO: string): Promise<{
  id: string
  join_url: string
  start_time: string
}> {
  const host = process.env.ZOOM_HOST_EMAIL || 'me'
  const res = await zoomFetch(`/users/${encodeURIComponent(host)}/meetings`, {
    method: 'POST',
    body: JSON.stringify({
      topic,
      type: 2, // scheduled meeting
      start_time: startUtcISO,
      duration: SLOT_MINUTES,
      timezone: 'UTC',
      settings: { join_before_host: false, waiting_room: true },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`zoom create meeting failed ${res.status}: ${body}`)
  }
  const data = (await res.json()) as { id: number | string; join_url: string; start_time: string }
  return { id: String(data.id), join_url: data.join_url, start_time: data.start_time }
}
