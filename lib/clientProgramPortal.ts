import { isEmailAddress } from './emailAddress'
import { supabase } from './supabase'
import { loadBusinessSettings } from './businessSettings'
import { brandKit, firstUrl, type Brand } from './brandKit'
import { initialsFrom } from './bookingPage'
import { signProgramToken } from './funnelLeadToken'
import { APP_URL } from './appUrls'

// What the client portal wears, and the one query that produces it.
//
// THE COACH'S BRAND, NOT MTM'S. The portal carries no MTM nav, logo or link —
// one footer line and nothing else — because the client bought from their coach
// and has no relationship with us.
//
// `users.avatar_url` IS NOT SELECTED, and that is the point rather than an
// oversight. It is the coach's ACCOUNT photo, uploaded to change the picture
// beside their own name in an admin panel, and publishing it on a page they
// have never seen is a leak whether or not it renders correctly. The same
// fallback reached api/ai-coach/profile.ts once, *because it was consistent
// with what render.ts did at the time* — a new public surface is the obvious
// third victim. Not selecting the column is the version of that rule a later
// edit cannot undo by accident: there is no value in scope to reach for.

/**
 * The client's door, minted from the program's CURRENT version.
 *
 * One producer, because a URL built in two places is two places that can
 * disagree about the path — and every link this returns dies the moment
 * portal_token_version is bumped, which is only true if the version is read
 * from the row rather than passed in by a caller who might hold a stale copy.
 */
export function programPortalUrl(program: { id: string; portal_token_version: number }): string {
  return `${APP_URL}/p/${signProgramToken(program.id, program.portal_token_version)}`
}

export type PortalBrand = Brand & {
  business_name: string
  logo_url: string | null
  /** Shown INSTEAD of a logo when there is none. Derived by lib/bookingPage.ts's
   *  initialsFrom — reused rather than rewritten, so the funnel page's monogram
   *  and the portal's are the same two letters. */
  initials: string
  /**
   * Where "Email {coach}" goes (§7.3). A plain mailto: — no threads, no storage,
   * no notifications. NULL hides the control rather than opening a blank compose
   * window, which is what a mailto with no address does.
   */
  reply_to: string | null
}

export type PortalCoach = { brand: PortalBrand; coachFirstName: string }

export async function loadPortalBrand(userId: string): Promise<PortalCoach> {
  const [settings, ownerRes] = await Promise.all([
    loadBusinessSettings(userId),
    // NAME AND EMAIL ONLY — see the avatar_url note above.
    supabase.from('users').select('name, email').eq('id', userId).maybeSingle(),
  ])
  const owner = (ownerRes.data || {}) as { name?: string | null; email?: string | null }
  const coachName = typeof owner.name === 'string' ? owner.name.trim() : ''
  const businessName = settings.business_name || coachName || 'Your coach'

  return {
    brand: {
      ...brandKit(settings),
      business_name: businessName,
      logo_url: firstUrl(settings.logo_url),
      initials: initialsFrom(businessName),
      reply_to: isEmail(owner.email) ? String(owner.email) : null,
    },
    // FIRST name, for "Call with Dana" on an ad-hoc session with no linked item.
    // Empty rather than a placeholder when the coach has no name on file: the
    // serializer decides what to render, and inventing "your coach" here would
    // put a made-up label somewhere it could not be distinguished from a real one.
    coachFirstName: coachName ? coachName.split(/\s+/)[0] : businessName,
  }
}

function isEmail(v: unknown): boolean {
  return isEmailAddress(v)
}
