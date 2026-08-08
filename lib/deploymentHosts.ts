// A PRODUCTION DEPLOYMENT HOLDING A PREVIEW URL.
//
// The class, not the instance. `GOOGLE_REDIRECT_URI` pointed at the raw Vercel
// deployment host for sixteen days: registered on the OAuth client, so it worked
// perfectly, and it read to a coach as
// `client-atm-api-<account>-<team>.vercel.app` on the same consent screen that
// already warns them Google has not verified the app.
//
// It works, so nothing fails. That is the whole difficulty — there is no error
// to notice, and the only person who sees the symptom is the customer.
//
// AND THE CONSENT SCREEN IS THE MILD CASE. `APP_URL` and `API_URL` are
// interpolated into EMAIL — the magic-link login URL and the nurture unsubscribe
// link. A consent screen is gone when the tab closes; a link in someone's inbox
// is permanent, still clicked months later, and points at a hostname derived
// from a Vercel account and project name, which is not a stable address to have
// baked into anything.
//
// ENVIRONMENT-SCOPED, NOT ABSOLUTE. Preview deployments SHOULD use *.vercel.app
// hosts — that is what they are, the callback is registered on the client for
// exactly that purpose, and warning there would train everyone to skip the line.
// Only production is wrong to be on one.
//
// WARNS, NEVER THROWS. Every one of these configurations WORKS on a deployment
// host. Refusing to build a URL over a cosmetic misconfiguration would turn a
// bad-looking link into no login at all, which is strictly worse.
//
// Same shape and the same reason as warnImplicitZoomHost in lib/zoom.ts:
// "works, but is silently misconfigured" is a class this project keeps meeting,
// and a log line is where it should surface rather than a customer's screen.

const DEPLOYMENT_HOST_SUFFIX = '.vercel.app'

// ONE ENTRY PER VARIABLE NAME, not one flag for the whole process. If two
// variables are wrong, both must be named — a single global flag would let the
// first one silence the second, and the second is the one nobody knows about.
const warned = new Set<string>()

/**
 * Log once per instance when `value` is a URL on a raw deployment host and this
 * is production.
 *
 * The message names the VARIABLE, its VALUE, and WHERE THE VALUE CAME FROM.
 *
 * The first two were the original point: a warning that says a URL is
 * misconfigured without saying which one costs the next reader the same search
 * that produced this function. The third was missing, and the gap is the same
 * shape one level down. Printing a value cannot tell you whether the variable is
 * set to that string or absent and falling back to it — and those send the
 * reader to different places in the Vercel dashboard. One is "edit this
 * variable", the other is "this variable does not exist yet". Guessing wrong
 * costs exactly the search the line exists to save.
 *
 * `name` is read back out of the environment to answer it, which is sound
 * because every call site passes the real variable name. A value that is present
 * but different from what the caller resolved is reported as its own case rather
 * than smoothed over: that can only happen if a caller transformed the value, and
 * silently calling it "set" would misdescribe it.
 */
export function warnIfDeploymentHost(name: string, value: string | null | undefined): void {
  if (warned.has(name)) return
  if (process.env.VERCEL_ENV !== 'production') return
  if (typeof value !== 'string' || !value) return

  let host: string
  try {
    host = new URL(value).host
  } catch {
    // Not a parseable URL. Not this function's problem — a malformed value fails
    // loudly wherever it is actually used, and throwing here would take a URL
    // builder down over a log line.
    return
  }
  if (!host.endsWith(DEPLOYMENT_HOST_SUFFIX)) return

  const fromEnv = process.env[name]
  const origin =
    typeof fromEnv === 'string' && fromEnv
      ? fromEnv === value
        ? `${name} IS SET to this value — edit the existing variable`
        : `${name} IS SET to ${fromEnv}, which the caller resolved to the value above`
      : `${name} IS NOT SET — this is the built-in fallback, so the variable has to be added, not edited`

  warned.add(name)
  console.warn(
    `[config] ${name} points at a raw deployment host on PRODUCTION: ${value}\n` +
      `  ${origin}.\n` +
      '  This host is derived from the Vercel account and project name, is not stable, and is visible to ' +
      'customers — on the Google consent screen, and permanently in any email built from it. ' +
      'Set it to the stable domain; leave the deployment URL registered wherever previews need it.'
  )
}

/** Test-only: the set is module scope, so one case would silence the next. */
export function _resetDeploymentHostWarningsForTests(): void {
  warned.clear()
}
