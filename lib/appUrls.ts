// Where the member-facing app lives, in ONE place.
//
// This existed as four separate `const APP_URL = process.env.APP_URL || …`
// declarations that disagreed about the default: api/auth/callback.ts and
// lib/email.ts said app.clientatmbuilder.com, api/calendar/google/{callback,
// connect}.ts said app.microtrainingmethod.com. Nothing forced them to agree,
// so whichever a new feature copied decided where its links pointed — which is
// exactly how the AI coach handoff URL ended up wrong twice, first by
// inheriting APP_URL and then by being given its own hardcoded guess.
//
// The app is served from app.microtrainingmethod.com as of the 2026-08-05
// domain cutover (client-atm-frontend, 0dbd744). The env var still wins; the
// default is now the same everywhere, so an unset variable degrades to correct
// rather than to whichever file the caller happened to copy.
export const APP_URL = process.env.APP_URL || 'https://app.microtrainingmethod.com'

/**
 * The base the LEAD-facing AI coach shell is served from.
 *
 * Separate from APP_URL on purpose even though they currently resolve to the
 * same host: they are different audiences and the shell may move independently
 * of the member app, and the whole reason this constant exists is that
 * inheriting APP_URL silently pointed disqualified leads at a 404.
 */
export const COACH_SHELL_URL = process.env.COACH_SHELL_URL || APP_URL

/** Join a base and a path without doubling or dropping the slash. */
export function appUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
