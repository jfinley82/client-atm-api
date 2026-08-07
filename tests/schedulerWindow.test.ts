process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ZOOM_ACCOUNT_ID = 'stub-account'
process.env.ZOOM_CLIENT_ID = 'stub-client'
process.env.ZOOM_CLIENT_SECRET = 'stub-secret'
process.env.ZOOM_SCHEDULE_ID = 'stub-schedule'

import { projectSelect } from './support/postgrest'
import { DEFAULT_WINDOW_DAYS, ZOOM_MAX_WINDOW_DAYS, clampSchedulerWindow } from '../lib/schedulerSlots'

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

const DAY_MS = 24 * 60 * 60 * 1000

// Every window we hand Zoom, captured as sent.
let zoomWindows: Array<{ from: string; to: string }> = []
// Slots the stub offers, keyed off nothing — the tests that care set this.
let stubSpots: string[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('zoom.us/oauth/token')) {
    return json({ access_token: 'stub-token', expires_in: 3600 })
  }

  if (url.includes('/scheduler/schedules/') && url.includes('available_times')) {
    const u = new URL(url)
    const from = u.searchParams.get('from') || ''
    const to = u.searchParams.get('to') || ''
    zoomWindows.push({ from, to })

    // THE REAL LIMIT, enforced exactly as Zoom enforces it. Asserting on the
    // clamp's own output would only prove the clamp agrees with itself; this
    // fails the same way production did if a window ever gets through unbounded.
    if (new Date(to).getTime() - new Date(from).getTime() > ZOOM_MAX_WINDOW_DAYS * DAY_MS) {
      return json(
        {
          error: {
            code: 400,
            message: 'The timeMax and timeMin intervals cannot exceed 45 days.',
            status: 'INVALID_ARGUMENT',
          },
        },
        400
      )
    }

    return json({
      duration: 30,
      days: [{ spots: stubSpots.map((start_time) => ({ start_time, status: 'available' })) }],
    })
  }

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

const iso = (ms: number) => new Date(ms).toISOString()

;(async () => {
  const availability: Handler = (await import('../api/calendar/availability')).default
  const { isSchedulerSlotOpen } = await import('../lib/schedulerSlots')

  console.log('\n-- the window that produced the real 502 --')
  // Caught in production runtime logs: six 502s in four minutes, all the same
  // Zoom 400. `from` and `to` came off the query string and were forwarded
  // unbounded — the default only applied when they were absent or unparseable,
  // so a well-formed WIDE window reached Zoom untouched every time.
  {
    zoomWindows = []
    stubSpots = []
    const now = Date.now()
    const r = makeRes()
    await availability(
      {
        method: 'GET',
        headers: {},
        query: { from: iso(now), to: iso(now + 180 * DAY_MS) },
      },
      r.res
    )
    ok('a six-month request is 200, not 502', r.out.status === 200, `${r.out.status} ${JSON.stringify(r.out.body)}`)
    ok('one call reached Zoom', zoomWindows.length === 1, String(zoomWindows.length))
    const span = new Date(zoomWindows[0].to).getTime() - new Date(zoomWindows[0].from).getTime()
    ok('and the window we sent is inside the 45-day limit', span <= ZOOM_MAX_WINDOW_DAYS * DAY_MS, `${(span / DAY_MS).toFixed(2)} days`)
    ok('while still being nearly the full 45 days, not the 14-day default', span > 44 * DAY_MS, `${(span / DAY_MS).toFixed(2)} days`)
    ok(
      'the response echoes the window actually served',
      typeof r.out.body?.from === 'string' && typeof r.out.body?.to === 'string',
      JSON.stringify(r.out.body)
    )
    ok(
      'so a caller can tell it was truncated',
      new Date(r.out.body.to).getTime() - new Date(r.out.body.from).getTime() < 180 * DAY_MS,
      `${r.out.body?.from} → ${r.out.body?.to}`
    )
  }

  console.log('\n-- 46 days is the edge, and it is on the safe side --')
  {
    for (const days of [44, 45, 46, 60, 365]) {
      zoomWindows = []
      const now = Date.now()
      const r = makeRes()
      await availability(
        { method: 'GET', headers: {}, query: { from: iso(now), to: iso(now + days * DAY_MS) } },
        r.res
      )
      ok(`a ${days}-day request is 200`, r.out.status === 200, `${r.out.status}`)
    }
  }

  console.log('\n-- the ordinary path is unchanged --')
  {
    zoomWindows = []
    const r = makeRes()
    await availability({ method: 'GET', headers: {}, query: {} }, r.res)
    ok('no params is 200', r.out.status === 200, `${r.out.status}`)
    const span = new Date(zoomWindows[0].to).getTime() - new Date(zoomWindows[0].from).getTime()
    ok(
      `and still defaults to ${DEFAULT_WINDOW_DAYS} days`,
      Math.abs(span - DEFAULT_WINDOW_DAYS * DAY_MS) < 60_000,
      `${(span / DAY_MS).toFixed(2)} days`
    )
    ok('slots come back under the key the page reads', Array.isArray(r.out.body?.slots), JSON.stringify(r.out.body))
  }

  console.log('\n-- clamping rules --')
  {
    const now = Date.now()
    const wide = clampSchedulerWindow(iso(now), iso(now + 200 * DAY_MS))
    ok(
      'an over-wide range is truncated from the END, keeping the start',
      wide.fromIso === iso(now),
      `${wide.fromIso} vs ${iso(now)}`
    )

    const inverted = clampSchedulerWindow(iso(now + 5 * DAY_MS), iso(now))
    ok(
      'an inverted range is read as the range described, not rejected',
      new Date(inverted.fromIso).getTime() < new Date(inverted.toIso).getTime(),
      `${inverted.fromIso} → ${inverted.toIso}`
    )

    const garbage = clampSchedulerWindow('not-a-date', 'also-not')
    const gSpan = new Date(garbage.toIso).getTime() - new Date(garbage.fromIso).getTime()
    ok(
      'unparseable params fall back to the default window',
      Math.abs(gSpan - DEFAULT_WINDOW_DAYS * DAY_MS) < 60_000,
      `${(gSpan / DAY_MS).toFixed(2)} days`
    )

    const noTo = clampSchedulerWindow(iso(now), null)
    ok(
      'a missing `to` is the default span from `from`',
      Math.abs(new Date(noTo.toIso).getTime() - now - DEFAULT_WINDOW_DAYS * DAY_MS) < 60_000,
      noTo.toIso
    )
  }

  console.log('\n-- booking a far-future slot: the same limit from the other end --')
  // isSchedulerSlotOpen widens `to` to cover the slot being validated, so a
  // start time past the cap used to blow the limit and make that slot
  // impossible to BOOK, not just to list. The window has to be re-anchored on
  // the slot rather than truncated, or the slot falls outside its own check.
  {
    zoomWindows = []
    const farStart = new Date(Date.now() + 120 * DAY_MS)
    farStart.setUTCMinutes(0, 0, 0)
    stubSpots = [farStart.toISOString()]

    const open = await isSchedulerSlotOpen(farStart.toISOString())
    ok('a slot 120 days out is still validated, not thrown on', open === true, String(open))
    ok('the window sent was legal', zoomWindows.length === 1 && new Date(zoomWindows[0].to).getTime() - new Date(zoomWindows[0].from).getTime() <= ZOOM_MAX_WINDOW_DAYS * DAY_MS)
    // Containing the slot is the whole point — a clamp that truncated the end
    // would have cut it out and rejected a bookable time.
    const f = new Date(zoomWindows[0].from).getTime()
    const t = new Date(zoomWindows[0].to).getTime()
    ok('and it contains the slot', farStart.getTime() >= f && farStart.getTime() <= t, `${zoomWindows[0].from} → ${zoomWindows[0].to}`)

    zoomWindows = []
    const soon = new Date(Date.now() + 3 * DAY_MS)
    soon.setUTCMinutes(0, 0, 0)
    stubSpots = [soon.toISOString()]
    ok('a near slot still validates', (await isSchedulerSlotOpen(soon.toISOString())) === true)
    ok(
      'and its window still spans the default listing range',
      new Date(zoomWindows[0].to).getTime() - new Date(zoomWindows[0].from).getTime() >= DEFAULT_WINDOW_DAYS * DAY_MS - 60_000,
      `${zoomWindows[0].from} → ${zoomWindows[0].to}`
    )

    stubSpots = []
    ok('an unoffered slot is still refused', (await isSchedulerSlotOpen(soon.toISOString())) === false)
  }

  console.log('\n-- a genuine Zoom failure is still a 502, not papered over --')
  // The fix removes a self-inflicted error. It must not turn a real upstream
  // outage into a 200 with an empty calendar, which is the same silent-dead-page
  // failure by another route.
  {
    const saved = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === 'string' ? input : input.url)
      if (url.includes('zoom.us/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('available_times')) return new Response('upstream exploded', { status: 500 })
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const r = makeRes()
    await availability({ method: 'GET', headers: {}, query: {} }, r.res)
    ok('a real Zoom 500 is still surfaced as 502', r.out.status === 502, `${r.out.status}`)
    ok('with no slots key to mistake for an empty calendar', r.out.body?.slots === undefined, JSON.stringify(r.out.body))
    globalThis.fetch = saved
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
