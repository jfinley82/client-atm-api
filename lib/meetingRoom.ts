import { loadBusinessSettings } from './businessSettings'
import { isZoomConfigured } from './zoom'

// WHERE A BOOKED CALL ACTUALLY HAPPENS. One rule, one function, stated once.
//
// Every booking has a HOST — the coach whose page or funnel it came through, or
// MTM itself for its own discovery calls. The room follows from that host and
// from nothing else:
//
//   1. The host IS the Zoom-integrated account  -> create a real Zoom meeting
//      EVERY BOOKING ON THIS BRANCH SHARES ONE ROOM. createZoomMeeting books on
//      the account's personal meeting room, so the join URLs differ only by the
//      appended meeting id (us02web.zoom.us/j/<pmi>?...&omn=<id>). Correct while
//      rule 1 means "this one account" and its host genuinely is that room; the
//      moment rule 1 widens past a single account, two coaches' clients land in
//      the same room and that assumption goes with it.
//   2. The host has a zoom_link                 -> use it
//   3. The host has Google connected            -> create a fresh Meet
//   4. Otherwise                                -> not bookable
//
// THE DEFECT THIS REPLACES. The rule used to be spread across two functions,
// and which one ran depended on whether the coach happened to have Google
// connected. A funnel whose owner had no Google fell through to the path that
// books MTM's shared Zoom account — so three real charge-demo leads were sent
// to Jamaul's personal room (us02web.zoom.us/j/4201272323), each with its own
// meeting id appended so nothing looked wrong. The coach was never in the room,
// and nobody could have told from the booking row.
//
// RULE 1 KEYS ON HOST IDENTITY, NOT ON A ROLE. "We have a Zoom integration for
// exactly this account" is true and stays true; "admins get Zoom" invites a
// second admin to inherit a Zoom account that is not theirs. That is the same
// distinction as booking_type: a fact about one account, not a class of them.
//
// AND IT IS NOT BUILT FOR A COACH ZOOM INTEGRATION, because there will not be
// one. Per-coach Zoom would need a published Marketplace app with security
// review and no external test-user allowance, so it is not a near-term option.
// Coaches connect Google for the calendar and paste a Zoom link if they want
// Zoom. If that ever changes, rule 1 widens from "this account" to "an account
// with a connection" and rules 2-4 are untouched.

export type MeetingRoom =
  | { kind: 'zoom_integration' }
  | { kind: 'zoom_link'; url: string }
  | { kind: 'google_meet' }
  | { kind: 'none' }

/**
 * Is this user the account MTM's Zoom integration actually belongs to?
 *
 * MTM-SIDE IDENTITY: a `users.id` in OUR database. It answers "which of our
 * accounts is the host", and nothing else.
 *
 * It is deliberately NOT ZOOM_HOST_EMAIL. That variable is the ZOOM-SIDE
 * identity — the user the Zoom API creates meetings as — and the two are
 * different people in practice: the Zoom account owner and the MTM admin who
 * owns the booking page are separate records in separate systems. One variable
 * serving both had no satisfiable value; setting it for Zoom broke MTM's own
 * booking page, and setting it for MTM broke every meeting create.
 *
 * An id rather than an email, because an email is a value two systems can both
 * plausibly claim, and that is precisely how they got conflated. A users.id
 * cannot be mistaken for a Zoom login.
 *
 * Unset => nobody is the host, so the coach path is simply unavailable rather
 * than misrouted. Same outcome production had before this variable existed.
 */
export function isZoomIntegrationHost(userId: string): boolean {
  const hostUserId = (process.env.ZOOM_HOST_MTM_USER_ID || '').trim()
  if (!hostUserId || !isZoomConfigured()) return false
  return userId === hostUserId
}

/**
 * Resolve the room for a booking, from its host.
 *
 * `hostUserId` is null only for MTM's own funnel-less booking page, which has no
 * coach: the integration account IS the host there by construction, so rule 1
 * applies without a lookup.
 *
 * `googleConnected` is passed in rather than looked up because the caller has
 * already resolved the token to decide whether it can create a calendar event.
 */
export async function resolveMeetingRoom(
  hostUserId: string | null,
  googleConnected: boolean
): Promise<MeetingRoom> {
  if (!hostUserId) {
    return isZoomConfigured() ? { kind: 'zoom_integration' } : { kind: 'none' }
  }

  if (isZoomIntegrationHost(hostUserId)) return { kind: 'zoom_integration' }

  const biz = await loadBusinessSettings(hostUserId)
  if (biz.zoom_link) return { kind: 'zoom_link', url: biz.zoom_link }

  if (googleConnected) return { kind: 'google_meet' }

  return { kind: 'none' }
}
