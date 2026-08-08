import { warnIfDeploymentHost } from './deploymentHosts'

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
 * The API's OWN public base — the host a magic-link login and a nurture
 * unsubscribe link point at.
 *
 * THIS EXISTED AS THREE COPIES, in lib/email.ts, lib/funnelNurture.ts and
 * lib/avatars.ts, and every one of them defaulted to the raw Vercel deployment
 * URL. That is the same disease this file was created to cure one variable over:
 * four `const APP_URL` declarations that disagreed about the default, so
 * whichever a new feature copied decided where its links pointed.
 *
 * Worse here than there, because two of the three consumers build EMAIL. A login
 * link on a deployment host is permanent in an inbox and still clicked months
 * later, and the host is derived from a Vercel account and project name.
 *
 * The default is now the stable domain, so an unset variable degrades to correct
 * rather than to a preview host.
 */
export const API_URL = process.env.API_URL || 'https://api.microtrainingmethod.com'

/**
 * The base the LEAD-facing AI coach shell is served from.
 *
 * Separate from APP_URL on purpose even though they currently resolve to the
 * same host: they are different audiences and the shell may move independently
 * of the member app, and the whole reason this constant exists is that
 * inheriting APP_URL silently pointed disqualified leads at a 404.
 */
export const COACH_SHELL_URL = process.env.COACH_SHELL_URL || APP_URL

// CHECKED AT MODULE LOAD, which is once per instance by construction. Every
// consumer of these imports this file, so the check cannot be skipped by a
// caller that forgot it — and a deployment that never builds a URL still logs
// the condition, which is the point.
warnIfDeploymentHost('APP_URL', APP_URL)
warnIfDeploymentHost('API_URL', API_URL)
warnIfDeploymentHost('COACH_SHELL_URL', COACH_SHELL_URL)

/** Join a base and a path without doubling or dropping the slash. */
export function appUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
