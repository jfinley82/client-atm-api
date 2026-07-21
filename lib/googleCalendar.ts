import { SignJWT, jwtVerify } from 'jose'
import { supabase } from './supabase'
import { encryptToken, decryptToken } from './cryptoTokens'
import type { Interval } from './availability'

// Google Calendar OAuth (server-side auth-code flow) + token refresh + free/busy.
// All Google calls live here so credentials never leave the backend. The redirect
// URI is ALWAYS read from GOOGLE_REDIRECT_URI (never hardcoded), so it tracks the
// Vercel env across environments.

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI)
}

// ---- CSRF state (signed, bound to the userId) --------------------------------

// Short-lived signed state so the public callback can trust which user began the
// flow. Reuses the app's JWT_SECRET; `purpose` scopes it to this flow only.
export async function signOAuthState(userId: string): Promise<string> {
  return new SignJWT({ userId, purpose: 'gcal_oauth' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(JWT_SECRET)
}

export async function verifyOAuthState(state: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(state, JWT_SECRET)
    if (payload.purpose !== 'gcal_oauth' || typeof payload.userId !== 'string') return null
    return { userId: payload.userId }
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
    access_token: tokens.access_token ?? null,
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
export async function getValidAccessToken(
  userId: string
): Promise<{ access_token: string; calendar_id: string } | null> {
  const { data: conn } = await supabase
    .from('calendar_connections')
    .select('access_token, refresh_token, expires_at, calendar_id')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()

  if (!conn) return null
  const calendarId = conn.calendar_id || 'primary'

  const notExpired = conn.access_token && conn.expires_at && new Date(conn.expires_at).getTime() > Date.now() + 60_000
  if (notExpired) return { access_token: conn.access_token as string, calendar_id: calendarId }

  const refreshToken = decryptToken(conn.refresh_token as string | null)
  if (!refreshToken) return null

  try {
    const refreshed = await refreshAccessToken(refreshToken)
    if (!refreshed.access_token) return null
    const update: Record<string, unknown> = {
      access_token: refreshed.access_token,
      expires_at: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }
    // Refresh tokens can rotate — persist the new one (encrypted) if present.
    if (refreshed.refresh_token) update.refresh_token = encryptToken(refreshed.refresh_token)
    await supabase.from('calendar_connections').update(update).eq('user_id', userId).eq('provider', 'google')
    return { access_token: refreshed.access_token, calendar_id: calendarId }
  } catch (err) {
    console.error('[googleCalendar] refresh failed', err)
    return null
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
