// The two magic-link lifetimes, and the one reason each.
//
// A LOGIN link is for someone sitting at the keyboard having just typed their
// email. Fifteen minutes is generous for that, and short enough that a stolen
// inbox is only briefly useful.
//
// An INVITE is for someone who has not asked for anything yet — a workshop
// attendee who opens the email that evening. A dead link is their first
// experience of the product, and they cannot fix it without asking for help.
// Seven days, single use, same redemption path (api/auth/callback.ts).
//
// Lengthening the login expiry to serve the invite would weaken every login for
// the sake of one flow. Two numbers, one owner.
//
// This module deliberately imports NOTHING. lib/email.ts, lib/memberInvite.ts
// and api/auth/send-magic-link.ts all read it, and memberInvite already imports
// email — a constant living in either of those would close that loop into an
// import cycle, which in a CommonJS build is a module-load failure waiting for
// the wrong call order.

export const LOGIN_TTL_MS = 15 * 60 * 1000

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type TokenKind = 'login' | 'invite'

export function ttlForKind(kind: TokenKind): number {
  return kind === 'invite' ? INVITE_TTL_MS : LOGIN_TTL_MS
}
