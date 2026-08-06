import { supabase } from './supabase'
import { loadUserAvailability } from './availabilitySettings'
import { WorkingHours } from './availability'
import { BookingQuestion, resolveBookingRequirements } from './bookingQuestions'

// The coach's own public booking page.
//
// One page per coach, addressed by a slug they choose, rendered to strangers
// with no session. Everything in this file exists to answer one question
// safely: what may an anonymous request learn about a coach?

// THE ENTIRE WORLD-READABLE SET. Six fields as of 2026-08-06.
//
// users.name was added deliberately: the design's name line is meant to say WHO
// you are meeting, and business_name reads cold when it is "Finley Coaching LLC".
// It is the only field here that does not live on funnel_business_settings.
//
// Everything else on that row stays private — email, phone (the COACH's),
// business_address, website, industry, tracking, legal, notification_prefs —
// which is exactly why nothing here ever returns the row itself.
//
// And never users.avatar_url. That is the account's profile picture, a private
// field, and it is NOT a fallback for headshot_url. headshot_url is a separate
// field a coach set on purpose for this page; a coach who has never opened this
// feature must not discover their account photo published because of it. The
// tempting one-line change is "use the avatar if there is no headshot" — there
// is a test asserting avatar_url never appears in a response, so that change
// fails loudly instead of shipping.
export const PUBLIC_BRAND_FIELDS = [
  'name',
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
  /** The coach's own name — what the name line above the title renders. */
  coachName: string | null
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

  // ONE column from users, by name. Not the row: avatar_url lives there too, and
  // it is private — see the note at the top of this file.
  const { data: userRow } = await supabase
    .from('users')
    .select('name')
    .eq('id', r.user_id as string)
    .maybeSingle()

  return {
    userId: r.user_id as string,
    slug: checked.slug,
    coachName: str((userRow as { name?: unknown } | null)?.name),
    businessName: str(r.business_name),
    logoUrl: str(r.logo_url),
    headshotUrl: str(r.headshot_url),
    primaryColor: str(r.brand_primary_color),
    secondaryColor: str(r.brand_secondary_color),
    title: str(r.booking_page_title) || DEFAULT_BOOKING_PAGE_TITLE,
    description: str(r.booking_page_description),
  }
}

/**
 * The app_settings key naming which coach MTM's OWN booking page belongs to.
 *
 * World-readable like everything in that allowlist, and that costs nothing here:
 * a booking slug is public by construction — it is the address strangers type.
 * This publishes which slug is the house one, not anything about the coach.
 *
 * It exists because MTM's internal book-a-call page has no slug in its URL. The
 * alternative was hardcoding 'jamaul', which is a fact about today's world
 * written into code that outlives it — the exact shape CLAUDE.md keeps
 * collecting instances of.
 */
export const BOOKING_HOST_SLUG_KEY = 'booking_host_slug'

/**
 * Resolve the booking page's host, with or without a slug.
 *
 * ONE RESOLVER, and deliberately not two. A slug that was supplied and a slug
 * that was looked up are the same kind of thing by the time they matter, so
 * they go through the same `resolveBookingSlug` and produce the same owner —
 * which is what makes "no slug" cost nothing to reason about: there is no
 * second payload shape to keep in step, and no second place for a rule to rot.
 *
 * NO FALLBACK BEYOND THE SETTING. Not the first admin, not the oldest user, not
 * the only coach with a slug. Every one of those is a guess that renders
 * confidently, and a booking page whose entire job is telling a stranger WHO
 * they are about to meet has no honest way to be unsure. Unset, malformed, or
 * pointing at a slug nobody owns all answer the same: null, which the endpoint
 * turns into a 404. A page with no host identity is a fixable state; a page
 * showing the wrong person is a call in somebody's calendar with a stranger.
 */
export async function resolveBookingHost(rawSlug: unknown): Promise<BookingPageOwner | null> {
  const supplied = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug
  if (typeof supplied === 'string' && supplied.trim()) return resolveBookingSlug(supplied)

  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', BOOKING_HOST_SLUG_KEY)
    .maybeSingle()
  // An unset key and a failed read are the same answer on purpose: neither is a
  // reason to show somebody a host we cannot name.
  if (error || !data?.value) return null

  return resolveBookingSlug(data.value)
}

// Which image the page's circle shows, decided here rather than in the
// component so every surface answers it the same way.
//
//   headshot -> the more personal choice, and a coach who set one meant it here
//   logo     -> otherwise
//   initials -> the coach's NAME, then their business name, then a glyph
//
// Never a broken image, never an empty circle, and never the account avatar.
//
// THE NAME COMES FIRST, and it did not used to. The spec said business_name,
// which was correct when business_name was the only name in the public set —
// and stopped being correct the moment users.name joined it. Implemented
// faithfully, it rendered "?" for any coach without a business name: verified
// live on /api/booking-page?slug=jamaul, which returned name "Jamaul",
// business_name null, initials "?". A page whose entire job is showing who you
// are meeting should not open with a question mark.
//
// Same failure as the stale comments in CLAUDE.md, one level up: a SPEC is also
// a claim about the world at the time it was written, and this one was
// invalidated by a later line in the same brief.
export type BookingPageAvatar =
  | { kind: 'image'; url: string }
  | { kind: 'initials'; initials: string }

export function bookingPageAvatar(owner: BookingPageOwner): BookingPageAvatar {
  if (owner.headshotUrl) return { kind: 'image', url: owner.headshotUrl }
  if (owner.logoUrl) return { kind: 'image', url: owner.logoUrl }
  return { kind: 'initials', initials: initialsFrom(owner.coachName || owner.businessName) }
}

// The glyph when there is genuinely nothing to derive initials from — no name
// and no business name. A bullet rather than '?', which reads as an error the
// visitor is expected to do something about; this is just a host who has not
// filled anything in.
export const NO_INITIALS_GLYPH = '\u2022'

export function initialsFrom(name: string | null): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return NO_INITIALS_GLYPH
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
  return (await loadUserAvailability(userId)).configured
}

export type PublicBookingPage = {
  slug: string
  /** The coach's name, for the line above the title. */
  name: string | null
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
  /** Whether the form must collect the lead's phone. */
  phone_required: boolean
  questions: BookingQuestion[]
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
  const [availability, configured, requirements] = await Promise.all([
    loadUserAvailability(owner.userId),
    hasConfiguredAvailability(owner.userId),
    // THE SAME resolver POST /api/calendar/book enforces from. The asterisk this
    // payload drives and the refusal the server issues come from one call, so a
    // coach flipping the phone toggle cannot leave the two disagreeing.
    resolveBookingRequirements({ coachUserId: owner.userId }),
  ])
  const wh = availability.working_hours as WorkingHours

  return {
    slug: owner.slug,
    name: owner.coachName,
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
    phone_required: requirements.phoneRequired,
    // The COACH's own questions, set in Profile -> Booking (decided 2026-08-06).
    // Never the global app_settings set: those are MTM's discovery-call
    // questions and would appear on a coach's page unasked. None configured
    // means name, email and phone, which is a complete booking.
    questions: requirements.questions,
  }
}
