import crypto from 'crypto'
import { SignJWT, jwtVerify } from 'jose'
import { supabase } from './supabase'
import { encryptToken, decryptToken } from './cryptoTokens'
import type { Interval } from './availability'

// Google Calendar OAuth (server-side auth-code flow) + token refresh + free/busy.
// All Google calls live here so credentials never leave the backend. The redirect
// URI is ALWAYS read from GOOGLE_REDIRECT_URI (never hardcoded), so it tracks the
// Vercel env across environments.

// The OAuth state is signed with a DISTINCT key derived from JWT_SECRET — NOT
// JWT_SECRET itself. This is deliberate: session tokens are signed with
// JWT_SECRET and verifySessionToken ignores custom claims, so if the state used
// the same key a leaked state (it travels in URLs → logs/Referer) would be
// accepted verbatim as a Bearer session. A separate key means a state can never
// verify as a session token, and vice versa.
const STATE_SECRET = crypto.createHmac('sha256', process.env.JWT_SECRET || '').update('gcal-oauth-state-v1').digest()

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI)
}

// ---- CSRF state (signed, bound to userId + a per-flow nonce) -----------------

// sha256 hex of the connect-time nonce cookie value. The state carries this HASH
// (states travel in URLs), and the callback re-hashes the cookie to match — so
// the flow is bound to the browser session that started it (blocks OAuth
// account-linking CSRF) without the state ever revealing the cookie value.
export function hashNonce(nonce: string): string {
  return crypto.createHash('sha256').update(nonce, 'utf8').digest('hex')
}

// Constant-time compare of a raw nonce against a stored hash.
export function nonceMatches(nonce: string | undefined | null, expectedHash: unknown): boolean {
  if (typeof nonce !== 'string' || !nonce || typeof expectedHash !== 'string' || !expectedHash) return false
  const a = Buffer.from(hashNonce(nonce), 'utf8')
  const b = Buffer.from(expectedHash, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Short-lived signed state so the public callback can trust which user began the
// flow and that this browser session started it. Signed with STATE_SECRET (see
// above) so it is unusable as a session token. `nh` = hashNonce(nonce cookie).
export async function signOAuthState(userId: string, nonceHash: string): Promise<string> {
  return new SignJWT({ userId, purpose: 'gcal_oauth', nh: nonceHash })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .setJti(crypto.randomUUID())
    .sign(STATE_SECRET)
}

export async function verifyOAuthState(state: string): Promise<{ userId: string; nonceHash: string } | null> {
  try {
    const { payload } = await jwtVerify(state, STATE_SECRET)
    if (payload.purpose !== 'gcal_oauth' || typeof payload.userId !== 'string' || typeof payload.nh !== 'string') {
      return null
    }
    return { userId: payload.userId, nonceHash: payload.nh }
  } catch {
    return null
  }
}

// ---- OAuth URLs / token exchange --------------------------------------------

export function buildConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // force a refresh token even on re-consent
    include_granted_scopes: 'true',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok) throw new Error(`google token ${res.status}: ${data.error || ''} ${data.error_description || ''}`)
  return data
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    grant_type: 'authorization_code',
  })
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    grant_type: 'refresh_token',
  })
}

// The connected account's primary-calendar address (its id === the email). Used
// to show which calendar is connected; needs only the calendar scopes already granted.
export async function fetchPrimaryEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: string }
    return typeof data.id === 'string' ? data.id : null
  } catch {
    return null
  }
}

// ---- connection persistence + valid-token accessor --------------------------

export type CalendarConnection = {
  user_id: string
  access_token: string | null
  refresh_token: string | null
  expires_at: string | null
  calendar_id: string | null
  calendar_email: string | null
  scope: string | null
}

// Store (or replace) a Google connection from a fresh token exchange. The
// refresh token is encrypted before it touches the DB. Preserves the existing
// refresh token when Google omits one on re-consent (shouldn't happen with
// prompt=consent, but never wipe a working token).
export async function saveGoogleConnection(
  userId: string,
  tokens: TokenResponse,
  calendarEmail: string | null
): Promise<void> {
  const { data: existing } = await supabase
    .from('calendar_connections')
    .select('refresh_token')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()

  const encRefresh = tokens.refresh_token
    ? encryptToken(tokens.refresh_token)
    : existing?.refresh_token ?? null

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null

  const row = {
    user_id: userId,
    provider: 'google',
    // Both tokens encrypted at rest — the access token is short-lived but is
    // still a live OAuth credential, so there's no reason to store it plaintext.
    access_token: tokens.access_token ? encryptToken(tokens.access_token) : null,
    refresh_token: encRefresh,
    expires_at: expiresAt,
    calendar_id: 'primary',
    calendar_email: calendarEmail,
    scope: tokens.scope ?? GOOGLE_SCOPES.join(' '),
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('calendar_connections').upsert(row, { onConflict: 'user_id,provider' })
  if (error) throw error
}

// A currently-valid access token for the coach, refreshing (and persisting any
// rotated refresh token) when the stored access token is expired. Returns null
// when the coach has no connection or the refresh fails.
export type ValidToken = { access_token: string; calendar_id: string; calendar_email: string | null }

export async function getValidAccessToken(userId: string): Promise<ValidToken | null> {
  const { data: conn } = await supabase
    .from('calendar_connections')
    .select('access_token, refresh_token, expires_at, calendar_id, calendar_email')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()

  if (!conn) return null
  const calendarId = conn.calendar_id || 'primary'
  const calendarEmail = (conn.calendar_email as string | null) ?? null

  // Use the stored access token if it's still valid and decryptable.
  const notExpired = conn.access_token && conn.expires_at && new Date(conn.expires_at).getTime() > Date.now() + 60_000
  if (notExpired) {
    const at = decryptToken(conn.access_token as string)
    if (at) return { access_token: at, calendar_id: calendarId, calendar_email: calendarEmail }
  }

  const refreshToken = decryptToken(conn.refresh_token as string | null)
  if (!refreshToken) return null

  try {
    const refreshed = await refreshAccessToken(refreshToken)
    if (!refreshed.access_token) return null
    const update: Record<string, unknown> = {
      access_token: encryptToken(refreshed.access_token),
      expires_at: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }
    // Refresh tokens can rotate — persist the new one (encrypted) if present.
    if (refreshed.refresh_token) update.refresh_token = encryptToken(refreshed.refresh_token)
    await supabase.from('calendar_connections').update(update).eq('user_id', userId).eq('provider', 'google')
    return { access_token: refreshed.access_token, calendar_id: calendarId, calendar_email: calendarEmail }
  } catch (err) {
    console.error('[googleCalendar] refresh failed', err)
    return null
  }
}

// Create an event on the coach's primary calendar (events.insert). When addMeet
// is true, a Google Meet conference is created and its URL read back. sendUpdates
// is 'none' — WE send our own branded confirmation + .ics, so Google should not
// double-email attendees. Returns null when the coach has no valid connection;
// throws on a Google API failure (the caller frees the reservation, like Zoom).
export async function createCalendarEvent(
  userId: string,
  opts: {
    summary: string
    description: string
    startIso: string
    endIso: string
    attendeeEmails: string[]
    timezone?: string
    location?: string
    addMeet?: boolean
  }
): Promise<{ eventId: string; htmlLink: string | null; meetUrl: string | null } | null> {
  const conn = await getValidAccessToken(userId)
  if (!conn) return null

  const tz = opts.timezone || 'UTC'
  const body: Record<string, unknown> = {
    summary: opts.summary,
    description: opts.description,
    start: { dateTime: opts.startIso, timeZone: tz },
    end: { dateTime: opts.endIso, timeZone: tz },
    attendees: opts.attendeeEmails.filter(Boolean).map((email) => ({ email })),
  }
  if (opts.location) body.location = opts.location
  if (opts.addMeet) {
    body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  }

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id)}/events?conferenceDataVersion=1&sendUpdates=none`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`google events.insert ${res.status}: ${t}`)
  }
  const data = (await res.json()) as {
    id?: string
    htmlLink?: string
    hangoutLink?: string
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
  }
  const meetUrl =
    data.hangoutLink ||
    data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ||
    null
  return { eventId: String(data.id || ''), htmlLink: data.htmlLink ?? null, meetUrl }
}

// Delete an event from the coach's calendar. Best-effort — returns true on
// success or if the event was already gone (404/410). Used for the reservation
// release path and (later) lead-side cancel.
export async function deleteCalendarEvent(userId: string, eventId: string): Promise<boolean> {
  const conn = await getValidAccessToken(userId)
  if (!conn) return false
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${conn.access_token}` }, signal: AbortSignal.timeout(15_000) }
    )
    return res.ok || res.status === 404 || res.status === 410
  } catch (err) {
    console.error('[googleCalendar] deleteCalendarEvent', err)
    return false
  }
}

// Busy intervals from the Google free/busy API for [timeMin, timeMax].
export async function fetchFreeBusy(
  accessToken: string,
  calendarId: string,
  timeMinISO: string,
  timeMaxISO: string
): Promise<Interval[]> {
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: calendarId }] }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`google freeBusy ${res.status}: ${body}`)
  }
  const data = (await res.json()) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }
  const busy = data.calendars?.[calendarId]?.busy
  return Array.isArray(busy) ? busy.filter((b) => typeof b.start === 'string' && typeof b.end === 'string') : []
}
