process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
// The legacy path checks isZoomConfigured() before anything else — MTM's shared
// host is what it books on. Production has these; without them the third-route
// test would be measuring a missing env var rather than the gate.
process.env.ZOOM_ACCOUNT_ID = 'a'
process.env.ZOOM_CLIENT_ID = 'b'
process.env.ZOOM_CLIENT_SECRET = 'c'
process.env.ZOOM_SCHEDULE_ID = 'sched'

import {
  bookingPageAvatar,
  initialsFrom,
  normalizeBookingSlug,
  NO_INITIALS_GLYPH,
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

// Shaped like the real storage URLs, which SHARE THE `avatars` BUCKET and both
// carry the coach's id — see the long note in tests/brandIdentity.test.ts. The
// leak assertion below therefore tests for the account OBJECT PATH, which
// appears in one and not the other. A guard phrased against the bucket, the id,
// or the storage host would catch the leak and also reject a legitimate
// headshot, and the tempting fix for that is to weaken the guard.
const STORAGE = 'https://stub.supabase.co/storage/v1/object/public'
const ACCOUNT_AVATAR = `${STORAGE}/avatars/avatars/${COACH}?v=1786022484350`
const ACCOUNT_OBJECT = `/avatars/avatars/${COACH}`

// A settings row with EVERY private field populated, so a leak has something to
// leak. The whole point of these assertions is that the response is built by
// construction rather than by subtraction — if it were a filtered row, adding a
// column here would start shipping it.
const SETTINGS_ROW: Record<string, unknown> = {
  user_id: COACH,
  booking_slug: 'alex-rivera',
  business_name: 'Rivera Coaching',
  logo_url: `${STORAGE}/avatars/brand/${COACH}/logo`,
  // Same bucket and same coach id as ACCOUNT_AVATAR, deliberately — a leak
  // assertion has to survive that collision to be worth having.
  headshot_url: `${STORAGE}/avatars/brand/${COACH}/headshot?v=1786024979335`,
  brand_primary_color: '#2C5F2D',
  brand_secondary_color: '#97BC62',
  booking_page_title: 'Consultation with Alex',
  booking_page_description: 'A 30-minute call to see if we are a fit.',
  booking_phone_required: true,
  booking_questions: [
    { id: 'q_goal', label: 'What are you hoping to solve?', type: 'single_line', required: true, order: 0 },
  ],
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
let globalPhoneRow: any = null
let funnelRowForId: any = null

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
  if (url.includes('/rest/v1/users')) return json({ id: COACH, name: 'Alex Rivera', avatar_url: ACCOUNT_AVATAR })
  if (url.includes('/rest/v1/app_settings')) return json(globalPhoneRow)
  if (url.includes('/rest/v1/funnels')) return json(funnelRowForId ? [funnelRowForId] : [])
  if (url.includes('/rest/v1/calendar_connections')) return json(null)
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
        coachName: null,
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

    // THE COACH'S NAME COMES FIRST. The spec said business_name, which was right
    // when that was the only name in the public set and wrong once users.name
    // joined it — live, /api/booking-page?slug=jamaul returned name "Jamaul",
    // business_name null, and initials "?". A page whose whole job is showing
    // who you are meeting must not open with a question mark.
    const neither = bookingPageAvatar(owner({ coachName: 'Alex Rivera' }))
    ok('initials come from the coach name', neither.kind === 'initials' && neither.initials === 'AR', JSON.stringify(neither))

    const jamaul = bookingPageAvatar(owner({ coachName: 'Jamaul', businessName: null }))
    ok('a coach with no business name still gets real initials', jamaul.kind === 'initials' && jamaul.initials === 'JA', JSON.stringify(jamaul))

    const businessOnly = bookingPageAvatar(owner({ coachName: null, businessName: 'Rivera Coaching' }))
    ok('business name is the fallback, not the first choice', businessOnly.kind === 'initials' && businessOnly.initials === 'RC', JSON.stringify(businessOnly))

    const nothing = bookingPageAvatar(owner({ coachName: null, businessName: null }))
    ok('with neither, a neutral glyph rather than an error mark', nothing.kind === 'initials' && nothing.initials === NO_INITIALS_GLYPH, JSON.stringify(nothing))
    ok('and never a question mark', nothing.kind === 'initials' && nothing.initials !== '?')

    ok('one word gives two letters', initialsFrom('Rivera') === 'RI')
    ok('three words take first and last', initialsFrom('Alex J Rivera') === 'AR')
    ok('no name gives the glyph rather than an empty circle', initialsFrom(null) === NO_INITIALS_GLYPH)
    ok('and a blank name too', initialsFrom('   ') === NO_INITIALS_GLYPH)

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

  console.log('\n-- ACCEPTANCE 2: the coach name is published, the avatar still is not --')
  {
    slugRow = SETTINGS_ROW
    const r = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, r.res)
    ok('the coach name is on the payload', r.out.body?.page?.name === 'Alex Rivera', JSON.stringify(r.out.body?.page?.name))
    ok('business_name is still there for the email fromName', r.out.body?.page?.business_name === 'Rivera Coaching')

    // users.name arrives from the SAME table as avatar_url, so this is the
    // moment the avatar could ride along. It must not.
    //
    // Tested by the account object's PATH, not by the bucket it sits in: a
    // coach's own headshot is served from the same bucket under the same id,
    // so a bucket-shaped assertion refuses a legitimate value.
    const strings = deepStrings(r.out.body)
    ok(
      'the account avatar is nowhere in the response',
      !strings.some((x) => x.includes(ACCOUNT_OBJECT)),
      JSON.stringify(strings)
    )
    ok('and no avatar_url key', !deepKeys(r.out.body).includes('avatar_url'))

    // The headshot the coach DID set comes back, from the same bucket, proving
    // the assertion above is discriminating rather than merely satisfied.
    ok(
      'while the brand headshot is published',
      typeof r.out.body?.page?.headshot_url === 'string' && r.out.body.page.headshot_url.includes('/avatars/'),
      JSON.stringify(r.out.body?.page?.headshot_url)
    )
  }

  console.log('\n-- ACCEPTANCE 5: a coach gets THEIR questions, never the global set --')
  {
    const withQuestions = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, withQuestions.res)
    const qs = withQuestions.out.body?.page?.questions
    ok('the coach configured question comes back', Array.isArray(qs) && qs.length === 1 && qs[0].id === 'q_goal', JSON.stringify(qs))

    slugRow = { ...SETTINGS_ROW, booking_questions: null }
    const none = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, none.res)
    ok(
      'a coach with none gets an empty array, not MTM discovery questions',
      Array.isArray(none.out.body?.page?.questions) && none.out.body.page.questions.length === 0,
      JSON.stringify(none.out.body?.page?.questions)
    )
    slugRow = SETTINGS_ROW
  }

  console.log('\n-- ACCEPTANCE 4: the page and the server read ONE resolver --')
  // Asserted directly rather than by testing each side and hoping. The value the
  // payload renders its asterisk from IS the value the booking validator
  // enforces, because both call resolveBookingRequirements.
  {
    const { resolveBookingRequirements } = await import('../lib/bookingQuestions')

    slugRow = { ...SETTINGS_ROW, booking_phone_required: true }
    const onPage = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, onPage.res)
    const onServer = await resolveBookingRequirements({ coachUserId: COACH })
    ok('required: page and server agree', onPage.out.body?.page?.phone_required === onServer.phoneRequired && onServer.phoneRequired === true, JSON.stringify([onPage.out.body?.page?.phone_required, onServer.phoneRequired]))

    slugRow = { ...SETTINGS_ROW, booking_phone_required: false }
    const offPage = makeRes()
    await page({ method: 'GET', headers: {}, query: { slug: 'alex-rivera' } }, offPage.res)
    const offServer = await resolveBookingRequirements({ coachUserId: COACH })
    ok('optional: page and server agree', offPage.out.body?.page?.phone_required === offServer.phoneRequired && offServer.phoneRequired === false, JSON.stringify([offPage.out.body?.page?.phone_required, offServer.phoneRequired]))

    // A missing row must read as REQUIRED, not as permission to skip.
    slugRow = { ...SETTINGS_ROW }
    delete (slugRow as any).booking_phone_required
    const missing = await resolveBookingRequirements({ coachUserId: COACH })
    ok('an unset column still requires the phone', missing.phoneRequired === true)
    slugRow = SETTINGS_ROW
  }

  console.log('\n-- coach-level refusal outranks form validation --')
  // Telling a visitor to fix their phone number on a page that cannot take
  // bookings at all is the same misleading-message problem one level down: they
  // would correct the field and be refused again for the real reason, which was
  // never shown.
  {
    const book: Handler = (await import('../api/calendar/book')).default
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    start.setUTCHours(14, 0, 0, 0)
    workingHoursRow = null
    slugRow = { ...SETTINGS_ROW, booking_phone_required: true }
    const r = makeRes()
    await book(
      {
        method: 'POST',
        headers: {},
        query: {},
        body: { booking_slug: 'alex-rivera', slot_start: start.toISOString(), first_name: 'A', last_name: 'B', email: 'a@example.com' },
      },
      r.res
    )
    ok(
      'an unconfigured coach answers coach_not_bookable, not phone_required',
      r.out.status === 503 && r.out.body?.error === 'coach_not_bookable',
      `${r.out.status} ${JSON.stringify(r.out.body)}`
    )
    workingHoursRow = {
      working_hours: { timezone: 'America/Chicago', mon: { start: '09:00', end: '17:00' } },
      slot_minutes: 30,
      buffer_minutes: 15,
      booking_window_days: 14,
    }
    slugRow = SETTINGS_ROW
  }

  console.log('\n-- the lead phone is validated loosely --')
  {
    const { normalizeLeadPhone } = await import('../lib/bookingQuestions')
    for (const good of ['+1 (555) 010-1234', '555-010-1234', '5550101234', '+44 20 7946 0958', '  555.010.1234  ']) {
      const r = normalizeLeadPhone(good)
      ok(`${JSON.stringify(good)} is accepted`, r.ok === true && !!r.phone, JSON.stringify(r))
    }
    // Stored as GIVEN — a coach reads and dials it.
    const asGiven = normalizeLeadPhone('+1 (555) 010-1234')
    ok('and kept in the shape its owner typed', asGiven.ok && asGiven.phone === '+1 (555) 010-1234', JSON.stringify(asGiven))

    for (const bad of ['12345', 'call me', '1234567890123456789', 'x'.repeat(50), '555-010-1234 ext WHATEVER']) {
      ok(`${JSON.stringify(bad.slice(0, 20))} is refused`, normalizeLeadPhone(bad).ok === false)
    }
    const absent = normalizeLeadPhone(undefined)
    ok('absent is fine and yields null', absent.ok === true && absent.phone === null)
    const blank = normalizeLeadPhone('   ')
    ok('blank is fine and yields null', blank.ok === true && blank.phone === null)
  }

  console.log('\n-- ACCEPTANCE 3 and 6: booking with a phone and a question --')
  {
    const book: Handler = (await import('../api/calendar/book')).default
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    start.setUTCHours(14, 0, 0, 0)

    async function attempt(body: Record<string, unknown>) {
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
            ...body,
          },
        },
        r.res
      )
      return r.out
    }

    slugRow = { ...SETTINGS_ROW, booking_phone_required: true }
    const noPhone = await attempt({ answers: { q_goal: 'growth' } })
    ok('a required phone is enforced', noPhone.status === 400 && noPhone.body?.error === 'phone_required', `${noPhone.status} ${JSON.stringify(noPhone.body)}`)
    ok('and the field is named', noPhone.body?.field === 'phone', JSON.stringify(noPhone.body))

    const badPhone = await attempt({ phone: 'call me', answers: { q_goal: 'growth' } })
    ok('a malformed phone is refused readably', badPhone.status === 400 && badPhone.body?.error === 'phone_invalid', JSON.stringify(badPhone.body))

    // ACCEPTANCE 6 — a configured question is enforced and NAMED.
    const noAnswer = await attempt({ phone: '555-010-1234' })
    ok('a missing configured answer is refused', noAnswer.status === 400 && noAnswer.body?.error === 'question_required', JSON.stringify(noAnswer.body))
    ok('and the refusal names that question', noAnswer.body?.question === 'What are you hoping to solve?', JSON.stringify(noAnswer.body))

    slugRow = { ...SETTINGS_ROW, booking_phone_required: false }
    const optional = await attempt({ answers: { q_goal: 'growth' } })
    ok('with the toggle off, no phone is accepted past validation', optional.body?.error !== 'phone_required', JSON.stringify(optional.body))
    slugRow = SETTINGS_ROW
  }

  console.log('\n-- ACCEPTANCE 1: the THIRD route, a funnel with no Google --')
  // coach_not_bookable covered the slug page and a Google-connected funnel.
  // A funnel whose owner has no Google connection never reaches bookCoachPath
  // (coachOwner requires `conn`), so it fell through to the legacy path and kept
  // answering 409 slot_taken. That is the worst case to leave uncovered: a coach
  // who never connected Google is the coach most likely never to have set their
  // hours either. charge-demo is exactly that coach.
  {
    const book: Handler = (await import('../api/calendar/book')).default
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    start.setUTCHours(14, 0, 0, 0)

    // A live funnel, owner with NO google connection (calendar_connections empty).
    funnelRowForId = { id: 'funnel-1', user_id: COACH, status: 'live', subdomain: 'charge-demo' }
    workingHoursRow = null

    const r = makeRes()
    await book(
      {
        method: 'POST',
        headers: {},
        query: {},
        body: {
          funnel_id: 'funnel-1',
          slot_start: start.toISOString(),
          first_name: 'A',
          last_name: 'B',
          email: 'a@example.com',
          phone: '555-010-1234',
        },
      },
      r.res
    )
    ok(
      'an unconfigured coach on the legacy path answers coach_not_bookable',
      r.out.status === 503 && r.out.body?.error === 'coach_not_bookable',
      `${r.out.status} ${JSON.stringify(r.out.body)}`
    )
    ok('not slot_taken, which sends the page into a retry loop', r.out.body?.error !== 'slot_taken', JSON.stringify(r.out.body))

    funnelRowForId = null
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
