process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.ZOOM_ACCOUNT_ID = 'a'
process.env.ZOOM_CLIENT_ID = 'b'
process.env.ZOOM_CLIENT_SECRET = 'c'
process.env.ZOOM_SCHEDULE_ID = 'sched'
// THE TWO IDENTITIES, HELD APART ON PURPOSE — this is the fixture the old one
// could not be. It set both to Jamaul, so a single variable serving both jobs
// looked correct and the suite was green while production could not work.
//
// These are the real production values in shape: the Zoom account's user is a
// DIFFERENT person from the MTM account that owns the booking page. If the two
// ever collapse back into one variable, this fixture fails.
process.env.ZOOM_HOST_EMAIL = 'teamfinley21@gmail.com'      // Zoom-side: a user in the Zoom account
process.env.ZOOM_HOST_MTM_USER_ID = 'user-jamaul'           // MTM-side: a users.id in our database

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

const JAMAUL = 'user-jamaul'
const COACH = 'user-coach'
const OTHER_ADMIN = 'user-other-admin'

const USERS: Record<string, { email: string }> = {
  [JAMAUL]: { email: 'workwithjamaul@gmail.com' },
  [COACH]: { email: 'coach@example.com' },
  // A SECOND ADMIN. The rule must not hand them MTM's Zoom account.
  [OTHER_ADMIN]: { email: 'someone-else@example.com' },
}

let settingsByUser: Record<string, any> = {}
const zoomCreateUrls: string[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) {
    const m = /id=eq\.([^&]+)/.exec(url)
    const id = m ? m[1] : ''
    return json(USERS[id] ? { id, ...USERS[id] } : null)
  }
  if (url.includes('/rest/v1/funnel_business_settings')) {
    const m = /user_id=eq\.([^&]+)/.exec(url)
    return json(settingsByUser[m ? m[1] : ''] ?? null)
  }

  if (url.includes('zoom.us/oauth/token')) return json({ access_token: 't', expires_in: 3600 })
  if (url.includes('api.zoom.us/v2/users/')) {
    zoomCreateUrls.push(url)
    return json({ id: '99', join_url: 'https://zoom.us/j/99', start_time: '2026-09-01T15:00:00Z' })
  }
  return json({})
}) as typeof fetch

;(async () => {
  const { resolveMeetingRoom, isZoomIntegrationHost } = await import('../lib/meetingRoom')

  console.log('\n-- rule 1: the Zoom integration belongs to ONE account, by identity --')
  {
    settingsByUser = {}
    ok('the integration host is recognised', isZoomIntegrationHost(JAMAUL))
    ok('an ordinary coach is not', !isZoomIntegrationHost(COACH))
    // THE POINT of keying on identity rather than a role: a second admin must not
    // inherit a Zoom account that is not theirs.
    ok('and neither is a second admin', !isZoomIntegrationHost(OTHER_ADMIN))

    const r = await resolveMeetingRoom(JAMAUL, false)
    ok('the host gets a real Zoom meeting', r.kind === 'zoom_integration', JSON.stringify(r))

    // Rule 1 outranks everything else, so Jamaul's own page does not silently
    // switch rooms the day he pastes a zoom_link or connects Google.
    settingsByUser = { [JAMAUL]: { zoom_link: 'https://zoom.us/j/personal' } }
    const withLink = await resolveMeetingRoom(JAMAUL, true)
    ok('and it outranks a zoom_link and Google', withLink.kind === 'zoom_integration', JSON.stringify(withLink))
  }

  console.log('\n-- rules 2, 3, 4 in order --')
  {
    settingsByUser = { [COACH]: { zoom_link: 'https://zoom.us/j/coachroom' } }
    const link = await resolveMeetingRoom(COACH, true)
    ok('a zoom_link wins over Google', link.kind === 'zoom_link' && link.url === 'https://zoom.us/j/coachroom', JSON.stringify(link))

    settingsByUser = { [COACH]: { zoom_link: null } }
    const meet = await resolveMeetingRoom(COACH, true)
    ok('Google alone gives a Meet', meet.kind === 'google_meet', JSON.stringify(meet))

    const none = await resolveMeetingRoom(COACH, false)
    ok('neither gives none', none.kind === 'none', JSON.stringify(none))

    // No settings row at all — teamfinley21's actual state.
    settingsByUser = {}
    const noRow = await resolveMeetingRoom(COACH, false)
    ok('a coach with no settings row is not bookable', noRow.kind === 'none', JSON.stringify(noRow))
  }

  console.log('\n-- THE REGRESSION: a coach is never put in MTM’s Zoom room --')
  // Three real charge-demo leads were booked into us02web.zoom.us/j/4201272323 —
  // Jamaul's personal room — because the path was chosen by whether the coach
  // had Google, and a coach without it fell through to MTM's shared Zoom. Each
  // booking carried its own meeting id, so nothing looked wrong in the row.
  {
    settingsByUser = {}
    const r = await resolveMeetingRoom(COACH, false)
    ok('no Google and no zoom_link is refused, not borrowed', r.kind === 'none', JSON.stringify(r))
    ok('specifically NOT the Zoom integration', r.kind !== 'zoom_integration')

    // Every other coach state also stays off the integration.
    for (const [label, settings, google] of [
      ['with a zoom_link', { zoom_link: 'https://zoom.us/j/x' }, false],
      ['with Google', { zoom_link: null }, true],
      ['with both', { zoom_link: 'https://zoom.us/j/x' }, true],
    ] as Array<[string, any, boolean]>) {
      settingsByUser = { [COACH]: settings }
      const room = await resolveMeetingRoom(COACH, google)
      ok(`a coach ${label} never resolves to the integration`, room.kind !== 'zoom_integration', JSON.stringify(room))
    }
  }

  console.log('\n-- MTM’s own page has no coach host, and that is rule 1 by construction --')
  {
    const r = await resolveMeetingRoom(null, false)
    ok('a null host is the integration account', r.kind === 'zoom_integration', JSON.stringify(r))
  }

  console.log('\n-- with Zoom unconfigured, nobody is the integration host --')
  // Otherwise a missing env var would silently promote whoever matches a blank
  // email, or route a booking to an integration that cannot answer.
  {
    const saved = process.env.ZOOM_ACCOUNT_ID
    delete process.env.ZOOM_ACCOUNT_ID
    ok('the host stops being the host', !isZoomIntegrationHost(JAMAUL))
    const r = await resolveMeetingRoom(null, false)
    ok('and MTM’s own page has no room rather than a broken one', r.kind === 'none', JSON.stringify(r))
    process.env.ZOOM_ACCOUNT_ID = saved
  }


  console.log('\n-- ACCEPTANCE 4: with the MTM-side identity unset, nothing new breaks --')
  // The state production was in before today. MTM's own page must still work and
  // the coach path must be unavailable, not misrouted — a missing variable may
  // remove a capability, never invent a failure mode.
  {
    const saved = process.env.ZOOM_HOST_MTM_USER_ID
    delete process.env.ZOOM_HOST_MTM_USER_ID

    ok('nobody is the integration host', !isZoomIntegrationHost(JAMAUL))
    settingsByUser = {}
    const coachPage = await resolveMeetingRoom(JAMAUL, false)
    ok('the coach path is not bookable', coachPage.kind === 'none', JSON.stringify(coachPage))
    const mtmPage = await resolveMeetingRoom(null, false)
    ok('and MTM\u2019s own page still works', mtmPage.kind === 'zoom_integration', JSON.stringify(mtmPage))

    process.env.ZOOM_HOST_MTM_USER_ID = ''
    ok('an empty value matches nobody, and matches no empty id either', !isZoomIntegrationHost(''))
    process.env.ZOOM_HOST_MTM_USER_ID = saved
  }

  console.log('\n-- ACCEPTANCE 3: the two identities are INDEPENDENT --')
  {
    // Moving the Zoom-side identity must not change which MTM account is the
    // host. Under the old single-variable design every one of these flipped it.
    const savedZoom = process.env.ZOOM_HOST_EMAIL
    for (const v of ['teamfinley21@gmail.com', 'workwithjamaul@gmail.com', 'someone@zoom.example', '']) {
      process.env.ZOOM_HOST_EMAIL = v
      ok(`MTM host is unchanged with ZOOM_HOST_EMAIL="${v}"`, isZoomIntegrationHost(JAMAUL))
      ok(`and a coach is still not the host with ZOOM_HOST_EMAIL="${v}"`, !isZoomIntegrationHost(COACH))
      const mtm = await resolveMeetingRoom(null, false)
      ok(`MTM\u2019s own page still resolves with ZOOM_HOST_EMAIL="${v}"`, mtm.kind === 'zoom_integration')
    }
    process.env.ZOOM_HOST_EMAIL = savedZoom

    // And the reverse: pointing the MTM-side identity at an account that is in no
    // way a Zoom host must not take MTM's page down.
    const savedMtm = process.env.ZOOM_HOST_MTM_USER_ID
    process.env.ZOOM_HOST_MTM_USER_ID = COACH
    const mtmStill = await resolveMeetingRoom(null, false)
    ok('MTM\u2019s page survives the MTM-side identity moving', mtmStill.kind === 'zoom_integration', JSON.stringify(mtmStill))
    ok('and the host follows the variable', isZoomIntegrationHost(COACH) && !isZoomIntegrationHost(JAMAUL))
    process.env.ZOOM_HOST_MTM_USER_ID = savedMtm
  }

  console.log('\n-- ACCEPTANCE 5: one variable, one meaning, checked at the source --')
  {
    const { readFileSync } = await import('fs')
    const read = (f: string) => readFileSync(f, 'utf8')
    // Comments legitimately NAME the other variable to explain the split, so
    // every count below is of actual reads, not of the string.
    const reads = (src: string) => (src.match(/process\.env\.ZOOM_HOST_EMAIL/g) || []).length

    ok('lib/meetingRoom.ts never reads ZOOM_HOST_EMAIL', reads(read('lib/meetingRoom.ts')) === 0,
       'the MTM-side identity must not be sourced from the Zoom-side one')
    ok('and it reads ZOOM_HOST_MTM_USER_ID instead', /process\.env\.ZOOM_HOST_MTM_USER_ID/.test(read('lib/meetingRoom.ts')))
    ok('lib/zoom.ts still reads it, because that is its one real consumer', reads(read('lib/zoom.ts')) === 1)

    // The ICS organizer was a THIRD meaning and the one the brief did not count:
    // three call sites fell back to ZOOM_HOST_EMAIL, so setting that variable
    // correctly printed the Zoom account's address on every client's invite.
    for (const f of ['api/calendar/book.ts', 'api/funnel/booking/reschedule.ts']) {
      ok(`${f} no longer sources an organizer from ZOOM_HOST_EMAIL`, reads(read(f)) === 0)
      ok(`${f} uses the owned fallback address`, /FALLBACK_ORGANIZER_EMAIL/.test(read(f)))
    }

    // The whole-repo count, so a new consumer cannot reintroduce the conflation
    // somewhere these per-file checks do not look.
    const { readdirSync, statSync } = await import('fs')
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = `${dir}/${f}`
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
      })
    const all = [...walk('lib'), ...walk('api')]
    const consumers = all.filter((f) => reads(read(f)) > 0)
    ok('exactly one file in lib/ + api/ reads ZOOM_HOST_EMAIL', consumers.length === 1, JSON.stringify(consumers))
    ok('and it is lib/zoom.ts', consumers[0] === 'lib/zoom.ts', JSON.stringify(consumers))
  }

  console.log('\n-- the ICS organizer is an address we own, not an integration credential --')
  {
    const { FALLBACK_ORGANIZER_EMAIL } = await import('../lib/ics')
    ok('it is on a domain we control', /@mail\.microtrainingmethod\.com$/.test(FALLBACK_ORGANIZER_EMAIL), FALLBACK_ORGANIZER_EMAIL)
    // Asserted by VALUE against the live Zoom-side identity, not by shape: a
    // guard that only checked the domain would pass on the day someone set
    // ZOOM_HOST_EMAIL to an address on our own domain.
    ok('and it is not whatever ZOOM_HOST_EMAIL currently is',
       FALLBACK_ORGANIZER_EMAIL !== process.env.ZOOM_HOST_EMAIL, FALLBACK_ORGANIZER_EMAIL)
    ok('specifically not the Zoom account user', FALLBACK_ORGANIZER_EMAIL !== 'teamfinley21@gmail.com')
  }

  console.log('\n-- ACCEPTANCE 1+2: BOTH paths resolve, and Zoom is called as the ZOOM-side user --')
  // The pair that has never been green together. Under the old design one
  // variable had to be Jamaul for this block's first half and teamfinley21 for
  // its second, so whichever value was set, one of these failed.
  {
    const { createZoomMeeting } = await import('../lib/zoom')
    settingsByUser = {}

    // (2) MTM's own /book-a-call — null host, rule 1 by construction.
    const mtm = await resolveMeetingRoom(null, false)
    ok('MTM\u2019s own page resolves to the Zoom integration', mtm.kind === 'zoom_integration', JSON.stringify(mtm))

    // (1) /book/jamaul — the coach path, which was unreachable before today.
    const coachPage = await resolveMeetingRoom(JAMAUL, false)
    ok('the coach page resolves to the Zoom integration too', coachPage.kind === 'zoom_integration', JSON.stringify(coachPage))

    // ...and both create their meeting as the ZOOM-side user. This is the
    // assertion that fails on the old code no matter which value is chosen.
    zoomCreateUrls.length = 0
    await createZoomMeeting('MTM call', '2026-09-01T15:00:00Z')
    await createZoomMeeting('Coach call', '2026-09-02T15:00:00Z')
    ok('two meetings were created', zoomCreateUrls.length === 2, JSON.stringify(zoomCreateUrls))

    const hostSegments = zoomCreateUrls.map((u) => /\/v2\/users\/([^/]+)\/meetings/.exec(u)?.[1] ?? '')
    ok('both are created as the Zoom account user',
       hostSegments.every((h) => h === 'teamfinley21%40gmail.com' || h === 'teamfinley21@gmail.com'),
       JSON.stringify(hostSegments))

    // The negative that names the actual 404 production hit: the Zoom API must
    // never be handed our MTM-side identity, in either of its forms.
    ok('and never as the MTM account email', !zoomCreateUrls.some((u) => u.includes('workwithjamaul')), JSON.stringify(zoomCreateUrls))
    ok('and never as the MTM users.id', !zoomCreateUrls.some((u) => u.includes(JAMAUL)), JSON.stringify(zoomCreateUrls))
  }

  console.log('\n-- an unconfigured Zoom host is visible in logs, ONCE --')
  // The 'me' fallback is correct-by-accident on a single-user Zoom account, and
  // that accident is what hid the conflation for months. It stays (it is the
  // right default) but it must stop being silent.
  {
    const { createZoomMeeting } = await import('../lib/zoom')
    const savedZoom = process.env.ZOOM_HOST_EMAIL
    const realWarn = console.warn
    const warns: string[] = []
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }

    delete process.env.ZOOM_HOST_EMAIL
    zoomCreateUrls.length = 0
    await createZoomMeeting('a', '2026-09-03T15:00:00Z')
    await createZoomMeeting('b', '2026-09-04T15:00:00Z')
    await createZoomMeeting('c', '2026-09-05T15:00:00Z')

    console.warn = realWarn
    process.env.ZOOM_HOST_EMAIL = savedZoom

    ok('the unset host is warned about', warns.some((w) => /ZOOM_HOST_EMAIL is unset/.test(w)), JSON.stringify(warns))
    // ONCE per instance, not once per booking — a line on every request buries
    // the condition in the noise it exists to stand out from.
    ok('exactly once across three bookings', warns.filter((w) => /ZOOM_HOST_EMAIL is unset/.test(w)).length === 1, JSON.stringify(warns))
    // And it still books, rather than refusing: the fallback is a real default.
    const hosts = zoomCreateUrls.map((u) => /\/v2\/users\/([^/]+)\/meetings/.exec(u)?.[1] ?? '')
    ok('and all three still created, as \'me\'', hosts.length === 3 && hosts.every((h) => h === 'me'), JSON.stringify(hosts))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
