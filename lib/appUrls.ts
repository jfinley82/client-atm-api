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
 * THE DEFAULT IS A DEPLOYMENT HOST, AND THAT IS NOW A LAG RATHER THAN A CHOICE.
 *
 * This was briefly `https://api.microtrainingmethod.com`, on the reasoning that
 * a stable domain beats a Vercel-derived one. It was reverted on 2026-08-08
 * because that host had no A record at the time — measured at 13:20 UTC, and
 * true then. It was pointed at this project later the same day, and at 17:35 it
 * resolves to 216.150.1.193 / 216.150.16.193 and answers authenticated API
 * requests. The earlier sentence in this comment asserted it did not exist,
 * which stopped being true a few hours after it was written: a claim about the
 * world is a snapshot with no expiry date, including one made honestly.
 *
 * So the default is no longer justified by "there is nowhere better to point".
 * It stays only because moving it changes the host in magic-link login emails,
 * which is a coach-visible change and somebody else's call. The cheaper route
 * needs no code at all: set API_URL on Production and the warning below stops.
 *
 * NOTE FOR WHOEVER CHECKS: Vercel's project API does not list api.* among this
 * project's domains, while it does list app.* for client-atm-frontend. The
 * behaviour is unambiguous and outranks the listing — a request for a
 * frontend-only route returns this project's 404, not the SPA — but the listing
 * is worth a glance in the dashboard, and it is why a domain check here should
 * be a request rather than an API read.
 */
export const API_URL =
  process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'

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
