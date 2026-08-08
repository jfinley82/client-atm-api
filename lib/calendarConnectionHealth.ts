// WHAT A BROKEN CALENDAR CONNECTION MEANS, in one place and with no I/O.
//
// `GET /api/calendar/google/status` used to report `connected: true` whenever a
// row existed in calendar_connections. It never asked Google anything, so what
// it actually answered was "a coach once completed the OAuth flow" — not "this
// calendar works". Those diverge the moment a refresh token dies, and the
// consequence is not cosmetic: lib/funnelAvailability.ts stops subtracting
// Google's busy blocks, so every meeting the coach has that MTM did not create
// becomes bookable, and api/calendar/book.ts books it anyway — correctly, by
// design. A lead takes a slot the coach is already busy in and both sides
// believe it worked.
//
// This module is the policy half: which failures are worth recording, what a
// coach should do about each, and which ones we must stop retrying. It is pure
// so the rules can be tested without a network or a database, and so the two
// callers that need them — lib/googleCalendar.ts and the status endpoint —
// cannot answer differently.

/**
 * The failures worth writing down.
 *
 * These are the CHECK constraint's values, and migration 097 must list exactly
 * these — tests/calendarConnectionHealth.test.ts asserts the two agree, because
 * a constant that has drifted from its constraint fails at 3am in production
 * rather than in the gate.
 *
 * THERE IS DELIBERATELY NO `unavailable`. A 500 from Google, a DNS failure or a
 * 15-second timeout is not evidence about the connection. Recording it would
 * make the column mean "the last call didn't work", which is not worth storing
 * and is actively harmful: one blip and a healthy coach is told to reconnect,
 * learns the warning is noise, and ignores the real one.
 */
export const INVALID_REASONS = ['invalid_grant', 'invalid_client', 'decrypt_failed'] as const
export type InvalidReason = (typeof INVALID_REASONS)[number]

/** What a caller should DO, derived at read time. `reason` is why; this is what. */
export type ConnectionState = 'not_connected' | 'connected' | 'needs_reconnect' | 'app_misconfigured'

export function isInvalidReason(v: unknown): v is InvalidReason {
  return typeof v === 'string' && (INVALID_REASONS as readonly string[]).includes(v)
}

/**
 * Reconnecting fixes it, so the coach is the one who can act.
 *
 * `invalid_grant` — the refresh token is dead (revoked, password changed,
 * grant expired). `decrypt_failed` — our key rotated or the ciphertext is
 * corrupt; ours to have caused, but a fresh consent writes fresh ciphertext, so
 * reconnecting is still the fix.
 *
 * `invalid_client` is NOT here, and that is the distinction the whole design
 * turns on. RECONNECTING USES THE SAME BROKEN CREDENTIALS, SO TELLING A COACH TO
 * RECONNECT IS A LOOP THAT CANNOT TERMINATE. Keep this sentence. It is what
 * stops someone collapsing four states back to two next quarter.
 */
export function isCoachFixable(reason: InvalidReason): boolean {
  return reason === 'invalid_grant' || reason === 'decrypt_failed'
}

/**
 * Whether to stop calling Google's token endpoint for this connection.
 *
 * Making `status` a discoverer puts a refresh behind a page the coach can
 * reload, so a dead connection would otherwise fire a doomed token request on
 * every load — a retry loop driven by a coach clicking refresh.
 *
 * The gate is exactly `isCoachFixable`, and that is not a coincidence: the
 * reasons we stop retrying are the ones a retry cannot fix and a reconnect can,
 * and a reconnect clears the column through saveGoogleConnection. So every
 * blocked connection has a way out.
 *
 * `invalid_client` KEEPS RETRYING on purpose. Its fix is an environment change
 * and a redeploy on our side, which touches no row — so if we blocked it, the
 * connection would stay marked broken after we fixed it, with nothing left to
 * notice. Retrying is how it heals: the next attempt succeeds and the success
 * path clears both columns. It is also global rather than per-coach, so it is an
 * alarm we would already be reacting to, not a loop we are quietly stuck in.
 */
export function blocksRefresh(reason: InvalidReason): boolean {
  return isCoachFixable(reason)
}

/**
 * The four states, derived from raw signals at read time rather than stored —
 * so a rule change reprices every existing row instead of leaving them stamped
 * against the old rule (see the SLA logic in lib/support.ts).
 */
export function connectionState(row: { invalid_reason?: unknown } | null | undefined): ConnectionState {
  if (!row) return 'not_connected'
  const reason = row.invalid_reason
  if (!isInvalidReason(reason)) return 'connected'
  return isCoachFixable(reason) ? 'needs_reconnect' : 'app_misconfigured'
}
