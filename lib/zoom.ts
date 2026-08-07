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
// dates/datetimes). Confirmed response shape (available_times, released
// 2026-07-13): { schedule_id, duration, days: [ { spots: [ { start_time,
// status, available_number } ] } ] }. Only spots with status === 'available'
// are returned (the payload mixes in 'unavailable' spots). start_time carries
// a local offset (e.g. -05:00); new Date() normalizes it to UTC. Slot length
// is the schedule's own top-level duration (SLOT_MINUTES only as a fallback if
// duration is missing).
export async function getSchedulerAvailability(fromISO: string, toISO: string): Promise<Slot[]> {
  const scheduleId = process.env.ZOOM_SCHEDULE_ID
  if (!scheduleId) throw new Error('ZOOM_SCHEDULE_ID not set')

  const qs = new URLSearchParams({ from: fromISO, to: toISO }).toString()
  const res = await zoomFetch(`/scheduler/schedules/${encodeURIComponent(scheduleId)}/available_times?${qs}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`zoom availability failed ${res.status}: ${body}`)
  }
  const data = (await res.json()) as {
    duration?: number
    days?: Array<{ spots?: Array<{ start_time?: unknown; status?: unknown }> }>
  }

  const durationMin = Number(data.duration) || SLOT_MINUTES
  const slots: Slot[] = []
  for (const day of Array.isArray(data.days) ? data.days : []) {
    for (const spot of Array.isArray(day.spots) ? day.spots : []) {
      if (spot.status !== 'available') continue
      if (typeof spot.start_time !== 'string') continue
      const ms = new Date(spot.start_time).getTime()
      if (Number.isNaN(ms)) continue
      slots.push({
        start: new Date(ms).toISOString(),
        end: new Date(ms + durationMin * 60_000).toISOString(),
      })
    }
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

// Creates a scheduled Zoom meeting at the chosen UTC start. Returns the fields
// the booking row and the customer confirmation need.
//
// ZOOM_HOST_EMAIL is the ZOOM-SIDE IDENTITY: it goes into the Zoom API path and
// must be a real user IN THE ZOOM ACCOUNT. Anything else is a 404
// `User does not exist`. It is NOT our users.email — which of OUR accounts is
// the host is a separate fact, and lives in ZOOM_HOST_MTM_USER_ID
// (lib/meetingRoom.ts). One variable answered both questions for months and no
// single value could satisfy them.
//
// 'me' resolves to the S2S app owner, which is correct-by-accident on a
// single-user Zoom account and is why the conflation stayed invisible. Kept,
// because it is the right default — but logged, so an unconfigured deployment
// is visible in logs instead of quietly working until it doesn't.
// Once per instance, not once per booking: the point is that the condition is
// discoverable in logs, and one line per request would bury it in the noise it
// is trying to stand out from.
let warnedImplicitZoomHost = false
function warnImplicitZoomHost(): void {
  if (warnedImplicitZoomHost) return
  warnedImplicitZoomHost = true
  console.warn(
    "[zoom] ZOOM_HOST_EMAIL is unset — creating meetings as 'me' (the S2S app owner). " +
      'This works on a single-user Zoom account and silently books the wrong host on any other. Set it explicitly.'
  )
}

export async function createZoomMeeting(topic: string, startUtcISO: string): Promise<{
  id: string
  join_url: string
  start_time: string
}> {
  const configuredHost = (process.env.ZOOM_HOST_EMAIL || '').trim()
  if (!configuredHost) warnImplicitZoomHost()
  const host = configuredHost || 'me'
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

// Move an existing meeting to a new time, keeping the same id and join URL.
//
// Used by the public reschedule flow. Without it a moved booking would keep a
// Zoom meeting stamped with the old time: the join link still works, but the
// meeting's own details — and anything Zoom shows the host — would disagree with
// what the attendee was told.
//
// Best-effort by return value rather than by throwing, so the caller can decide
// whether a failed patch should roll the move back.
export async function updateZoomMeetingTime(meetingId: string, startUtcISO: string): Promise<boolean> {
  try {
    const res = await zoomFetch(`/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ start_time: startUtcISO, duration: SLOT_MINUTES, timezone: 'UTC' }),
    })
    // 204 on success. 404 means the meeting is already gone, which is not a
    // reason to block a move the database has accepted.
    if (res.ok || res.status === 404) return true
    console.error('[zoom] update meeting failed', res.status, await res.text().catch(() => ''))
    return false
  } catch (err) {
    console.error('[zoom] update meeting threw', err)
    return false
  }
}

// Delete a meeting on cancel, so a canceled booking does not leave a live room
// on the shared host's calendar. Tolerates an already-deleted meeting for the
// same reason deleteCalendarEvent does: cancel must be idempotent.
export async function deleteZoomMeeting(meetingId: string): Promise<void> {
  try {
    const res = await zoomFetch(`/meetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      console.error('[zoom] delete meeting failed', res.status, await res.text().catch(() => ''))
    }
  } catch (err) {
    console.error('[zoom] delete meeting threw', err)
  }
}
