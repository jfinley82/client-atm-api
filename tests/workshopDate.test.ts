process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { createSessionToken } from '../lib/auth'
import { normalizeSettingValue } from '../lib/appSettings'
import { WORKSHOP_TIME_ZONE, normalizeWorkshopDate, parseWorkshopDate } from '../lib/workshopDate'

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

const ADMIN = 'user-admin'
let settings: Record<string, string> = {}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) return json({ id: ADMIN, role: 'admin' })
  if (url.includes('/rest/v1/app_settings')) {
    if (method === 'POST') {
      for (const row of Array.isArray(body) ? body : [body]) settings[row.key] = row.value
      return json(Array.isArray(body) ? body : [body])
    }
    return json(Object.entries(settings).map(([key, value]) => ({ key, value })))
  }
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

;(async () => {
  const adminSettings: Handler = (await import('../api/admin/settings/index')).default

  console.log('\n-- a time can be set, and survives the round trip --')
  // The whole point. Before this, the column took any string and nothing parsed
  // it, so there was no such thing as "a time" — only characters.
  {
    settings = {}
    const r = makeRes()
    await adminSettings(
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${await createSessionToken(ADMIN)}` },
        query: {},
        body: { workshop_event_date: '2026-08-28T14:30' },
      },
      r.res
    )
    ok('a datetime-local value is accepted', r.out.status === 200, `${r.out.status} ${JSON.stringify(r.out.body)}`)
    ok(
      'and is stored with an explicit offset, not left naive',
      settings.workshop_event_date === '2026-08-28T14:30-04:00',
      settings.workshop_event_date
    )
    ok(
      'the response returns the canonical value, so the form shows what was stored',
      r.out.body?.settings?.workshop_event_date === '2026-08-28T14:30-04:00',
      JSON.stringify(r.out.body?.settings)
    )
  }

  console.log('\n-- the offset is resolved per instant, not assumed --')
  // A hardcoded -04:00 would be wrong for half the year. August is EDT, January
  // is EST, and the difference is a workshop starting an hour off.
  {
    ok('August is -04:00 (EDT)', normalizeWorkshopDate('2026-08-28T14:30') === '2026-08-28T14:30-04:00', String(normalizeWorkshopDate('2026-08-28T14:30')))
    ok('January is -05:00 (EST)', normalizeWorkshopDate('2026-01-15T14:30') === '2026-01-15T14:30-05:00', String(normalizeWorkshopDate('2026-01-15T14:30')))
    ok('the zone is named, not implied', WORKSHOP_TIME_ZONE === 'America/New_York')

    // The instant is what a consumer actually renders from. 14:30 EDT is 18:30Z.
    const parsed = parseWorkshopDate('2026-08-28T14:30')
    ok('and the parsed instant is correct', parsed?.instant?.toISOString() === '2026-08-28T18:30:00.000Z', String(parsed?.instant?.toISOString()))
  }

  console.log('\n-- a date with no time is still valid, and says so --')
  // The existing admin form sends this shape. Rejecting it would break Save
  // until the frontend grows a time input, and "that day" is a real thing to mean.
  {
    const dayOnly = parseWorkshopDate('2026-08-28')
    ok('a bare date is accepted', dayOnly?.value === '2026-08-28', JSON.stringify(dayOnly))
    ok('hasTime is false, so a consumer need not invent midnight', dayOnly?.hasTime === false)
    ok('and there is no instant to render', dayOnly?.instant === null)

    const withTime = parseWorkshopDate('2026-08-28T14:30')
    ok('hasTime is true when one was given', withTime?.hasTime === true)
  }

  console.log('\n-- every shape the form might send --')
  {
    const cases: Array<[string, string]> = [
      ['2026-08-28', '2026-08-28'],
      ['2026-08-28T14:30', '2026-08-28T14:30-04:00'],
      ['2026-08-28T14:30:00', '2026-08-28T14:30-04:00'],
      ['2026-08-28T14:30-04:00', '2026-08-28T14:30-04:00'],
      ['2026-08-28T14:30-0400', '2026-08-28T14:30-04:00'],
      ['2026-08-28T18:30Z', '2026-08-28T18:30+00:00'],
      ['2026-08-28 14:30', '2026-08-28T14:30-04:00'],
      ['  2026-08-28T14:30  ', '2026-08-28T14:30-04:00'],
      ['', ''],
    ]
    for (const [input, expected] of cases) {
      const got = normalizeWorkshopDate(input)
      ok(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, got === expected, String(got))
    }

    // An explicit offset is trusted rather than re-derived — a coach running one
    // workshop from another zone is allowed to say so.
    ok(
      'a non-Eastern offset is preserved as given',
      normalizeWorkshopDate('2026-08-28T14:30+02:00') === '2026-08-28T14:30+02:00',
      String(normalizeWorkshopDate('2026-08-28T14:30+02:00'))
    )
  }

  console.log('\n-- garbage is refused rather than stored --')
  // This is the defect that lost the original time: the column took anything.
  {
    for (const bad of ['tomorrow', '28/08/2026', '2026-13-01', '2026-02-30', '2026-08-28T25:00', '2026-08-28T14:70', 'Aug 28 2026', '2026-08', 'null']) {
      ok(`${JSON.stringify(bad)} is rejected`, normalizeWorkshopDate(bad) === null, String(normalizeWorkshopDate(bad)))
    }
    ok('a non-string is rejected', normalizeWorkshopDate(20260828 as unknown) === null)
  }

  console.log('\n-- the write path refuses it too, with a message that says the shape --')
  {
    settings = { workshop_event_date: '2026-08-28T14:30-04:00' }
    const r = makeRes()
    await adminSettings(
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${await createSessionToken(ADMIN)}` },
        query: {},
        body: { workshop_event_date: 'next tuesday' },
      },
      r.res
    )
    ok('a meaningless date is 400', r.out.status === 400, `${r.out.status}`)
    ok('the message shows an accepted shape', /2026-08-28T14:30/.test(r.out.body?.error || ''), JSON.stringify(r.out.body))
    ok('and the stored value is untouched', settings.workshop_event_date === '2026-08-28T14:30-04:00', settings.workshop_event_date)
  }

  console.log('\n-- a rejected key in a multi-key save writes nothing --')
  // All-or-nothing: validation completes before the upsert, so a bad date cannot
  // take half a form's worth of good values down with it, or land them without
  // itself.
  {
    settings = {}
    const r = makeRes()
    await adminSettings(
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${await createSessionToken(ADMIN)}` },
        query: {},
        body: { login_headline: 'Welcome back', workshop_event_date: 'garbage' },
      },
      r.res
    )
    ok('the save is 400', r.out.status === 400, `${r.out.status}`)
    ok('and the good key was NOT written either', settings.login_headline === undefined, JSON.stringify(settings))
  }

  console.log('\n-- other settings are untouched by this --')
  // Only keys with a real format get an entry. Free text stays free text.
  {
    const passthrough = normalizeSettingValue('login_headline', '  keep   my spacing  ')
    ok('login_headline passes through byte for byte', passthrough.ok && passthrough.value === '  keep   my spacing  ', JSON.stringify(passthrough))
    const colour = normalizeSettingValue('primary_color', 'not-a-colour')
    ok('primary_color is not validated here', colour.ok === true)
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
