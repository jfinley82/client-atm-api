import { supabase } from './supabase'
import { loadUserAvailability } from './availabilitySettings'
import { WorkingHours } from './availability'

// The coach's own public booking page.
//
// One page per coach, addressed by a slug they choose, rendered to strangers
// with no session. Everything in this file exists to answer one question
// safely: what may an anonymous request learn about a coach?

// THE ENTIRE WORLD-READABLE SET. Approved 2026-08-06, and deliberately short.
//
// Not the coach's personal name (users.name), not email, phone,
// business_address, tracking, legal or notification_prefs — all of which live
// on the SAME ROW as the fields below, which is exactly why nothing here ever
// returns that row.
//
// And never users.avatar_url. That is the account's profile picture, a private
// field, and it is NOT a fallback for headshot_url. headshot_url is a separate
// field a coach set on purpose for this page; a coach who has never opened this
// feature must not discover their account photo published because of it. The
// tempting one-line change is "use the avatar if there is no headshot" — there
// is a test asserting avatar_url never appears in a response, so that change
// fails loudly instead of shipping.
export const PUBLIC_BRAND_FIELDS = [
  'business_name',
  'logo_url',
  'headshot_url',
  'brand_primary_color',
  'brand_secondary_color',
] as const

export const DEFAULT_BOOKING_PAGE_TITLE = 'Book a call'

// Applied at read time rather than stored, so changing it reprices every page
// instead of leaving rows stamped against the old default.
const SLUG_MIN = 3
const SLUG_MAX = 40

// Lowercase, digits and single hyphens. No leading or trailing hyphen, no dots
// (they would read as a domain), no underscores (they vanish under a link
// underline), no uppercase (two slugs differing only in case would look like
// one link and route to two coaches).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

// Words that already mean something at the top level of a host or path, or that
// a stranger would read as MTM speaking rather than a coach. Refused so a coach
// cannot claim an address that misrepresents them or collides with a route.
const RESERVED_SLUGS = new Set([
  'api', 'admin', 'app', 'www', 'mail', 'book', 'booking', 'bookings', 'call',
  'calls', 'login', 'logout', 'signup', 'signin', 'auth', 'dashboard', 'settings',
  'profile', 'account', 'billing', 'support', 'help', 'docs', 'blog', 'about',
  'terms', 'privacy', 'legal', 'status', 'assets', 'static', 'public', 'cdn',
  'mtm', 'microtrainingmethod', 'micro-training-method', 'coach', 'test',
])

export type SlugCheck = { ok: true; slug: string } | { ok: false; error: string }

/**
 * Validate and canonicalise a coach-supplied slug.
 *
 * Trims and lowercases before checking, so a coach typing "Alex-Rivera" gets
 * "alex-rivera" rather than a validation error for something they would
 * reasonably consider the same thing.
 */
export function normalizeBookingSlug(raw: unknown): SlugCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'slug_invalid' }
  const slug = raw.trim().toLowerCase()
  if (!slug) return { ok: false, error: 'slug_required' }
  if (slug.length < SLUG_MIN) return { ok: false, error: 'slug_too_short' }
  if (slug.length > SLUG_MAX) return { ok: false, error: 'slug_too_long' }
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'slug_invalid' }
  if (slug.includes('--')) return { ok: false, error: 'slug_invalid' }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'slug_reserved' }
  return { ok: true, slug }
}

export type BookingPageOwner = {
  userId: string
  slug: string
  businessName: string | null
  logoUrl: string | null
  headshotUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  title: string
  description: string | null
}

/**
 * Resolve a slug to its coach.
 *
 * Selects the columns it needs BY NAME. Never `select('*')`, and never a row
 * spread into a response: the private fields on this table outnumber the public
 * ones, so the safe default has to be exclusion by construction rather than a
 * deny-list somebody has to remember to update.
 */
export async function resolveBookingSlug(rawSlug: unknown): Promise<BookingPageOwner | null> {
  const checked = normalizeBookingSlug(rawSlug)
  if (!checked.ok) return null

  const { data } = await supabase
    .from('funnel_business_settings')
    .select(
      'user_id, booking_slug, business_name, logo_url, headshot_url, brand_primary_color, brand_secondary_color, booking_page_title, booking_page_description'
    )
    .eq('booking_slug', checked.slug)
    .maybeSingle()
  if (!data) return null

  const r = data as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

  return {
    userId: r.user_id as string,
    slug: checked.slug,
    businessName: str(r.business_name),
    logoUrl: str(r.logo_url),
    headshotUrl: str(r.headshot_url),
    primaryColor: str(r.brand_primary_color),
    secondaryColor: str(r.brand_secondary_color),
    title: str(r.booking_page_title) || DEFAULT_BOOKING_PAGE_TITLE,
    description: str(r.booking_page_description),
  }
}

// Which image the page's circle shows, decided here rather than in the
// component so every surface answers it the same way.
//
//   headshot -> the more personal choice, and a coach who set one meant it here
//   logo     -> otherwise
//   initials -> otherwise, from the business name; never a broken image, never
//               an empty circle, and never the account avatar
export type BookingPageAvatar =
  | { kind: 'image'; url: string }
  | { kind: 'initials'; initials: string }

export function bookingPageAvatar(owner: BookingPageOwner): BookingPageAvatar {
  if (owner.headshotUrl) return { kind: 'image', url: owner.headshotUrl }
  if (owner.logoUrl) return { kind: 'image', url: owner.logoUrl }
  return { kind: 'initials', initials: initialsFrom(owner.businessName) }
}

export function initialsFrom(name: string | null): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/**
 * Has this coach actually configured when they are available?
 *
 * WHY THIS IS NOT "did computeOpenSlots return anything". loadUserAvailability
 * falls back to DEFAULT_WORKING_HOURS when no row exists — 9 to 5, Monday to
 * Friday, in UTC. So a coach who has never opened their calendar settings does
 * not look unavailable; they look available at hours they never chose, in a
 * timezone that is almost certainly not theirs. Publishing that is worse than
 * publishing an empty calendar, because a stranger can book it.
 *
 * Configured means: a row exists AND at least one day has a window.
 */
export async function hasConfiguredAvailability(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('user_availability')
    .select('working_hours')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return false
  const wh = (data as { working_hours: unknown }).working_hours
  if (!wh || typeof wh !== 'object') return false
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
  return days.some((d) => {
    const w = (wh as Record<string, unknown>)[d]
    return !!w && typeof w === 'object'
  })
}

export type PublicBookingPage = {
  slug: string
  business_name: string | null
  logo_url: string | null
  headshot_url: string | null
  brand_primary_color: string | null
  brand_secondary_color: string | null
  avatar: BookingPageAvatar
  title: string
  description: string | null
  slot_minutes: number
  timezone: string
  accepting_bookings: boolean
  questions: unknown[]
}

/**
 * The page's whole public payload, built as an EXPLICIT OBJECT.
 *
 * Never a settings row with keys deleted. A response assembled by subtraction is
 * one refactor away from carrying everything again — somebody adds a column,
 * nobody updates the deny-list, and a private field ships. Every key below was
 * written on purpose.
 */
export async function buildPublicBookingPage(owner: BookingPageOwner): Promise<PublicBookingPage> {
  const [availability, configured] = await Promise.all([
    loadUserAvailability(owner.userId),
    hasConfiguredAvailability(owner.userId),
  ])
  const wh = availability.working_hours as WorkingHours

  return {
    slug: owner.slug,
    business_name: owner.businessName,
    logo_url: owner.logoUrl,
    headshot_url: owner.headshotUrl,
    brand_primary_color: owner.primaryColor,
    brand_secondary_color: owner.secondaryColor,
    avatar: bookingPageAvatar(owner),
    title: owner.title,
    description: owner.description,
    slot_minutes: availability.slot_minutes,
    timezone: wh.timezone,
    // The page renders "not taking bookings" from this rather than inferring it
    // from an empty slot list, which cannot tell "none this fortnight" from
    // "never set any up".
    accepting_bookings: configured,
    // DELIBERATELY EMPTY, and the key is present so the contract does not change
    // when it stops being. There is no per-coach question store: booking
    // questions live either on a funnel or in the global app_settings set, and
    // this page belongs to neither — the same reason its title cannot borrow a
    // funnel's offer copy. Wiring it to the coach's most recent funnel would
    // reintroduce exactly the coupling this page exists to avoid. Giving it its
    // own store is one migration plus a Profile Settings field; it needs a
    // decision, not a guess.
    questions: [],
  }
}
