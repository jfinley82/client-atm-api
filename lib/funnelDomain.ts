// THE PUBLIC HOST FUNNELS ARE SERVED UNDER, in one place.
//
// This existed as EIGHT sites. Seven read `process.env.FUNNEL_PUBLIC_DOMAIN ||
// 'freeminiworkshop.com'` — seven copies of the same fallback literal, agreeing
// by luck rather than by construction — and the eighth,
// api/funnels/[id]/publish.ts, hardcoded `microtrainingmethod.com` with no env
// var at all, under a comment reading "The public host funnels are served
// under."
//
// That one was not a cosmetic disagreement. `charge-demo.freeminiworkshop.com`
// serves the live funnel; `charge-demo.microtrainingmethod.com` is NXDOMAIN, and
// will stay that way because that apex now serves the marketing site. So the URL
// a coach was handed the instant they pressed Publish — the moment they are most
// likely to copy it and send it to their list — resolved to nothing at all. Not
// a wrong page. A DNS error.
//
// WHAT THIS MODULE OWNS AND WHAT IT DOES NOT.
//
// It owns every URL and host string WE WRITE: publish's response, hub links,
// nurture emails, the booking-manage link, the guide PDF, the preview email, and
// the display labels the funnel page renders into its own copy.
//
// It does NOT own where requests actually land. That is DNS plus the host rules
// in vercel.json, which is static JSON and cannot read an environment variable.
// So `FUNNEL_PUBLIC_DOMAIN` is not a switch that moves the funnels; it is the
// value we must keep EQUAL to the domain vercel.json routes. Setting it to
// something else does not relocate anything — it makes us advertise an address
// nothing answers on, which is precisely the failure above, one variable over.
//
// tests/funnelDomain.test.ts therefore compares this module against vercel.json
// directly, rather than asserting either one against a constant. Two artifacts
// that must agree, asserted against each other — same reason as
// tests/ctaSeam.test.ts.
//
// WHY microtrainingmethod.com IS NOT AN ALTERNATIVE SPELLING. It never routed to
// render — it was GHL, and it is now the marketing site Jamaul published on
// 2026-08-08. There is no wildcard on it and there will not be one, so any funnel
// link built on it is dead, not merely off-brand.

export const FUNNEL_PUBLIC_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'

/**
 * The host a funnel is reached at: `charge-demo.freeminiworkshop.com`.
 *
 * With no subdomain this is the apex, which is the hub rather than any one
 * funnel — `guideRender` and the preview email both fall back to it when a
 * coach has no funnel yet, and it is a real page in both cases.
 */
export function funnelHost(subdomain?: string | null): string {
  const sub = typeof subdomain === 'string' ? subdomain.trim() : ''
  return sub ? `${sub}.${FUNNEL_PUBLIC_DOMAIN}` : FUNNEL_PUBLIC_DOMAIN
}

/** The same host as an absolute base: `https://charge-demo.freeminiworkshop.com`. */
export function funnelUrl(subdomain?: string | null): string {
  return `https://${funnelHost(subdomain)}`
}
