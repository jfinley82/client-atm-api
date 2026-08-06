process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import {
  bookingPageAvatar,
  initialsFrom,
  normalizeBookingSlug,
  PUBLIC_BRAND_FIELDS,
} from '../lib/bookingPage'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0,
  fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++
    console.log('  PASS', label)
  } else {
    fail++
    console.log('  FAIL', label, extra ? '\n      ' + extra : '')
  }
}

const COACH = 'coach-1'

// A settings row with EVERY private field populated, so a leak has something to
// leak. The whole point of these assertions is that the response is built by
// construction rather than by subtraction — if it were a filtered row, adding a
// column here would start shipping it.
const SETTINGS_ROW: Record<string, unknown> = {
  user_id: COACH,
  booking_slug: 'alex-rivera',
  business_name: 'Rivera Coaching',
  logo_url: 'https://cdn.example.com/logo.png',
  headshot_url: 'https://cdn.example.com/headshot.jpg',
  brand_primary_color: '#2C5F2D',
  brand_secondary_color: '#97BC62',
  booking_page_title: 'Consultation with Alex',
  booking_page_description: 'A 30-minute call to see if we are a fit.',
  // None of these may ever appear in a public response.
  email: 'alex@private.example.com',
  phone: '+1 555 0100',
  business_address: '1 Private Road',
  website: 'https://private.example.com',
  industry: 'coaching',
  years_in_business: '6',
  tracking: { ga: 'G-PRIVATE' },
  legal: { terms: 'private terms' },
  notification_prefs: { booking: true },
  theme_mode: 'light',
  brand_font: 'Inter',
  zoom_link: 'https://zoom.us/j/private',
}

let workingHoursRow: any = {
  working_hours: { timezone: 'America/Chicago', mon: { start: '09:00', end: '17:00' } },
  slot_minutes: 30,
  buffer_minutes: 15,
  booking_window_days: 14,
}
let slugRow: Record<string, unknown> | null = SETTINGS_ROW

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/funnel_business_settings')) {
    const m = /booking_slug=eq\.([^&]+)/.exec(url)
    if (m) return json(slugRow && slugRow.booking_slug === m[1] ? slugRow : null)
    return json(slugRow)
  }
  if (url.includes('/rest/v1/user_availability')) return json(workingHoursRow)
  if (url.includes('/rest/v1/bookings')) return json([])
  return json({})
}) as typeof fetch

function makeRes() {
  const out: any = { status: 0, body: null }
  const res: any = {
    setHeader() {},
    status(c: number) {
      out.status = c
      return res
    },
    json(v: unknown) {
      out.body = v
      return res
    },
    end() {
      return res
    },
  }
  return { res, out }
}

// Every string anywhere in a payload, however deeply nested. A leak check that
// only looks at top-level keys is not a leak check.
function deepStrings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === 'string') acc.push(v)
  else if (Array.isArray(v)) v.forEach((x) => deepStrings(x, acc))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => deepStrings(x, acc))
  return acc
}
function deepKeys(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, acc))
  else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      acc.push(k)
      deepKeys(val, acc)
    }
  }
  return acc
}

;(async () => {
  const page: Handler = (await import('../api/booking-page/index')).default

  console.log('\n-- slug validation --')
  {
    ok('a plain slug passes', normalizeBookingSlug('alex-rivera').ok)
    const upper = normalizeBookingSlug('  Alex-Rivera  ')
    ok('trimmed and lowercased rather than rejected', upper.ok && upper.slug === 'alex-rivera', JSON.stringify(upper))

    const cases: Array<[unknown, string]> = [
      ['ab', 'slug_too_short'],
      ['a'.repeat(41), 'slug_too_long'],
      ['alex rivera', 'slug_invalid'],
      ['alex.rivera', 'slug_invalid'],
      ['alex_rivera', 'slug_invalid'],
      ['-alex', 'slug_invalid'],
      ['alex-', 'slug_invalid'],
      ['alex--rivera', 'slug_invalid'],
      ['api', 'slug_reserved'],
      ['admin', 'slug_reserved'],
      ['book', 'slug_reserved'],
      ['mtm', 'slug_reserved'],
      ['', 'slug_required'],
      [42, 'slug_invalid'],
    ]
    for (const [input, expected] of cases) {
      const r = normalizeBookingSlug(input)
      ok(`${JSON.stringify(input)} -> ${expected}`, !r.ok && r.error === expected, JSON.stringify(r))
    }
    // The reason is distinguishable, so the field can say WHICH mistake.
    ok('reasons are distinct, not one generic error', new Set(cases.map((c) => c[1])).size === 5)
  }

  console.log('\n-- ACCEPTANCE 11: the public payload carries only the approved fields --')
  {
    slugRow = SETTINGS_ROW
    const r = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, r.res)
    ok('200 for a claimed slug', r.out.status === 200, `${r.out.status} ${JSON.stringify(r.out.body)}`)

    const payload = r.out.body
    const strings = deepStrings(payload)
    const keys = deepKeys(payload)

    // By VALUE, not by key name — a leak that renamed the key still leaks.
    const forbidden: Array<[string, string]> = [
      ['email', 'alex@private.example.com'],
      ['phone', '+1 555 0100'],
      ['business_address', '1 Private Road'],
      ['website', 'https://private.example.com'],
      ['tracking', 'G-PRIVATE'],
      ['legal', 'private terms'],
      ['zoom_link', 'https://zoom.us/j/private'],
    ]
    for (const [name, value] of forbidden) {
      ok(`no ${name} value anywhere in the payload`, !strings.includes(value), JSON.stringify(strings))
    }
    for (const k of ['email', 'phone', 'business_address', 'tracking', 'legal', 'notification_prefs', 'avatar_url', 'user_id']) {
      ok(`no '${k}' key anywhere in the payload`, !keys.includes(k), JSON.stringify(keys))
    }

    // And the approved five ARE present.
    for (const f of PUBLIC_BRAND_FIELDS) {
      ok(`${f} is returned`, f in payload.page, JSON.stringify(Object.keys(payload.page)))
    }
    ok('the title comes from the page, not a funnel', payload.page.title === 'Consultation with Alex', payload.page.title)
    ok('slot_minutes and timezone come from the coach', payload.page.slot_minutes === 30 && payload.page.timezone === 'America/Chicago', JSON.stringify([payload.page.slot_minutes, payload.page.timezone]))
  }

  console.log('\n-- ACCEPTANCE 12: which image the circle shows, and never the avatar --')
  {
    const owner = (over: Record<string, unknown>) =>
      ({
        userId: COACH,
        slug: 's',
        businessName: 'Rivera Coaching',
        logoUrl: null,
        headshotUrl: null,
        primaryColor: null,
        secondaryColor: null,
        title: 't',
        description: null,
        ...over,
      }) as any

    const withBoth = bookingPageAvatar(owner({ headshotUrl: 'h.jpg', logoUrl: 'l.png' }))
    ok('headshot wins over logo', withBoth.kind === 'image' && withBoth.url === 'h.jpg', JSON.stringify(withBoth))

    const logoOnly = bookingPageAvatar(owner({ logoUrl: 'l.png' }))
    ok('logo when there is no headshot', logoOnly.kind === 'image' && logoOnly.url === 'l.png', JSON.stringify(logoOnly))

    const neither = bookingPageAvatar(owner({}))
    ok('initials when there is neither', neither.kind === 'initials' && neither.initials === 'RC', JSON.stringify(neither))

    ok('one word gives two letters', initialsFrom('Rivera') === 'RI')
    ok('three words take first and last', initialsFrom('Alex J Rivera') === 'AR')
    ok('no name still gives something rather than an empty circle', initialsFrom(null) === '?')
    ok('and a blank name too', initialsFrom('   ') === '?')

    // THE GUARD THAT MATTERS. The tempting future change is "use the account
    // avatar when there is no headshot", which would publish every coach's
    // profile picture. Nothing in the resolver may read it.
    const { readFileSync } = await import('fs')
    const src = readFileSync(process.cwd() + '/lib/bookingPage.ts', 'utf8')
    ok(
      'lib/bookingPage.ts never reads avatar_url',
      !/avatar_url\s*[:.\]]/.test(src.replace(/\/\/.*$/gm, '')),
      'avatar_url referenced outside a comment — that field is private and is NOT a headshot fallback'
    )
  }

  console.log('\n-- ACCEPTANCE 2: an unknown slug is a clean 404, and says nothing more --')
  {
    slugRow = null
    const r = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'nobody-here' } }, r.res)
    ok('404', r.out.status === 404, `${r.out.status}`)
    ok('with a bare error', JSON.stringify(r.out.body) === JSON.stringify({ error: 'not_found' }), JSON.stringify(r.out.body))

    // A malformed slug answers identically — whether a slug COULD exist is not
    // a fact worth handing to someone enumerating them.
    const bad = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'Not A Slug!' } }, bad.res)
    ok('a malformed slug is the same 404', bad.out.status === 404 && bad.out.body?.error === 'not_found', `${bad.out.status} ${JSON.stringify(bad.out.body)}`)
    slugRow = SETTINGS_ROW
  }

  console.log('\n-- ACCEPTANCE 5: unconfigured availability is stated, not implied --')
  // loadUserAvailability falls back to 9-5 weekdays in UTC when no row exists,
  // so "no slots" and "never set any up" are different facts and the page needs
  // to be told which. Otherwise a stranger books hours the coach never chose.
  {
    const availability: Handler = (await import('../api/booking-page/availability')).default

    workingHoursRow = null
    const none = makeRes()
    await availability({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, none.res)
    ok('200 rather than an error', none.out.status === 200, `${none.out.status}`)
    ok('accepting_bookings is false', none.out.body?.accepting_bookings === false, JSON.stringify(none.out.body))
    ok('and no slots are offered', Array.isArray(none.out.body?.slots) && none.out.body.slots.length === 0, JSON.stringify(none.out.body?.slots))

    // A row with every day off is the same answer by a different route.
    workingHoursRow = { working_hours: { timezone: 'America/Chicago' }, slot_minutes: 30, buffer_minutes: 15, booking_window_days: 14 }
    const allOff = makeRes()
    await availability({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, allOff.res)
    ok('every day off also reads as not accepting', allOff.out.body?.accepting_bookings === false, JSON.stringify(allOff.out.body))

    workingHoursRow = {
      working_hours: { timezone: 'America/Chicago', mon: { start: '09:00', end: '17:00' } },
      slot_minutes: 30,
      buffer_minutes: 15,
      booking_window_days: 14,
    }
    const configured = makeRes()
    await availability({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, configured.res)
    ok('a configured coach accepts bookings', configured.out.body?.accepting_bookings === true, JSON.stringify(configured.out.body))
    // ACCEPTANCE 4: no Google is not an error state.
    ok('connected:false is reported, not treated as failure', configured.out.status === 200 && configured.out.body?.connected === false, JSON.stringify(configured.out.body))
    ok('the coach window is echoed so the calendar can bound itself', configured.out.body?.window_days === 14, JSON.stringify(configured.out.body?.window_days))
  }

  console.log('\n-- method and input guards --')
  {
    const noSlug = makeRes()
    await page({ method: 'GET', headers: {}, query: {} }, noSlug.res)
    ok('no slug is 400', noSlug.out.status === 400, `${noSlug.out.status}`)

    const post = makeRes()
    await page({ method: 'POST', headers: {}, query: { slug: 'alex-rivera' } }, post.res)
    ok('POST is 405', post.out.status === 405, `${post.out.status}`)
  }

  console.log('\n-- the live defect: an unconfigured coach is not bookable ANYWHERE --')
  // Measured on production before this fix: a live funnel whose coach had no
  // user_availability row served 110 anonymous bookable slots at 09:00-16:30
  // UTC — weekday hours nobody chose, in a timezone that was not theirs, with
  // nothing subtracting real commitments. 09:00 UTC is 4am in Chicago.
  //
  // Gated inside computeOpenSlots and isSlotOpen rather than at each call site,
  // so the funnel page, the funnel booking submit, the reschedule check and the
  // coach page cannot disagree.
  {
    const { computeOpenSlots, isSlotOpen } = await import('../lib/funnelAvailability')

    workingHoursRow = null
    const slots = await computeOpenSlots(COACH, undefined, undefined)
    ok('no row means no slots, not default office hours', slots.slots.length === 0, JSON.stringify(slots.slots.slice(0, 3)))

    // The ACCEPT side matters as much as the list: without it a stranger could
    // POST a slot the page never offered.
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    soon.setUTCHours(10, 0, 0, 0)
    ok('and no slot validates for booking either', (await isSlotOpen(COACH, soon.toISOString())) === false)

    workingHoursRow = { working_hours: { timezone: 'America/Chicago' }, slot_minutes: 30, buffer_minutes: 15, booking_window_days: 14 }
    ok('every day off is the same answer', (await computeOpenSlots(COACH, undefined, undefined)).slots.length === 0)

    const { loadUserAvailability } = await import('../lib/availabilitySettings')
    workingHoursRow = null
    ok('an absent row reports configured:false', (await loadUserAvailability(COACH)).configured === false)
    workingHoursRow = {
      working_hours: { timezone: 'America/Chicago', tue: { start: '09:00', end: '17:00' } },
      slot_minutes: 30,
      buffer_minutes: 15,
      booking_window_days: 14,
    }
    ok('one configured day is enough', (await loadUserAvailability(COACH)).configured === true)
  }

  console.log('\n-- refusing for the RIGHT reason --')
  // The gate refused correctly and reported the wrong cause: isSlotOpen gained a
  // second reason to be false, and the caller still mapped false -> slot_taken
  // because taken was the only reason it could previously be false. Measured
  // against production: a slot with zero active bookings came back 409
  // slot_taken. The frontend retries on 409 by refreshing the slots — which for
  // an unconfigured coach returns an empty list, so the page asks someone to
  // pick another time from nothing, forever.
  {
    const book: Handler = (await import('../api/calendar/book')).default
    const slugRowSaved = slugRow
    slugRow = SETTINGS_ROW

    async function attempt() {
      const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      start.setUTCHours(12, 45, 0, 0)
      const r = makeRes()
      await book(
        {
          method: 'POST',
          headers: {},
          query: {},
          body: {
            booking_slug: 'alex-rivera',
            slot_start: start.toISOString(),
            first_name: 'A',
            last_name: 'B',
            email: 'a@example.com',
          },
        },
        r.res
      )
      return r.out
    }

    workingHoursRow = null
    const unconfigured = await attempt()
    ok('an unconfigured coach refuses with 503, not 409', unconfigured.status === 503, `${unconfigured.status} ${JSON.stringify(unconfigured.body)}`)
    ok(
      'and names the actual cause',
      unconfigured.body?.error === 'coach_not_bookable',
      JSON.stringify(unconfigured.body)
    )
    ok(
      'never slot_taken, which would send the page into a retry loop',
      unconfigured.body?.error !== 'slot_taken',
      JSON.stringify(unconfigured.body)
    )
    ok(
      'the code matches the one the no-meeting-room branch already uses',
      unconfigured.body?.error === 'coach_not_bookable'
    )

    slugRow = slugRowSaved
    workingHoursRow = {
      working_hours: { timezone: 'America/Chicago', mon: { start: '09:00', end: '17:00' } },
      slot_minutes: 30,
      buffer_minutes: 15,
      booking_window_days: 14,
    }
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
