process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'
process.env.ZOOM_ACCOUNT_ID = 'a'
process.env.ZOOM_CLIENT_ID = 'b'
process.env.ZOOM_CLIENT_SECRET = 'c'
process.env.ZOOM_SCHEDULE_ID = 'sched'
process.env.ZOOM_HOST_EMAIL = 'workwithjamaul@gmail.com'

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
  return json({})
}) as typeof fetch

;(async () => {
  const { resolveMeetingRoom, isZoomIntegrationHost } = await import('../lib/meetingRoom')

  console.log('\n-- rule 1: the Zoom integration belongs to ONE account, by identity --')
  {
    settingsByUser = {}
    ok('the integration host is recognised', await isZoomIntegrationHost(JAMAUL))
    ok('an ordinary coach is not', !(await isZoomIntegrationHost(COACH)))
    // THE POINT of keying on identity rather than a role: a second admin must not
    // inherit a Zoom account that is not theirs.
    ok('and neither is a second admin', !(await isZoomIntegrationHost(OTHER_ADMIN)))

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
    ok('the host stops being the host', !(await isZoomIntegrationHost(JAMAUL)))
    const r = await resolveMeetingRoom(null, false)
    ok('and MTM’s own page has no room rather than a broken one', r.kind === 'none', JSON.stringify(r))
    process.env.ZOOM_ACCOUNT_ID = saved
  }

  console.log('\n-- a blank ZOOM_HOST_EMAIL matches nobody --')
  {
    const saved = process.env.ZOOM_HOST_EMAIL
    process.env.ZOOM_HOST_EMAIL = ''
    ok('not even the account whose email is empty', !(await isZoomIntegrationHost(JAMAUL)))
    process.env.ZOOM_HOST_EMAIL = saved
  }

  console.log('\n-- email matching is case- and whitespace-insensitive --')
  {
    const saved = process.env.ZOOM_HOST_EMAIL
    process.env.ZOOM_HOST_EMAIL = '  WorkWithJamaul@Gmail.com  '
    ok('the same account still matches', await isZoomIntegrationHost(JAMAUL))
    process.env.ZOOM_HOST_EMAIL = saved
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
