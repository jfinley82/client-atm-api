process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { projectSelect } from './support/postgrest'
import { createSessionToken } from '../lib/auth'
import { ALLOWED_SETTING_KEYS } from '../lib/appSettings'
import { normalizeBookingTypes } from '../lib/bookingQuestions'

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
const MEMBER = 'user-member'

// The app_settings table, as rows.
let settings: Record<string, string> = {}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) {
    const m = /[?&]id=eq\.([^&]+)/.exec(url)
    const id = m ? m[1] : ''
    return json(id === ADMIN ? { id, role: 'admin' } : { id, role: 'user' })
  }

  if (url.includes('/rest/v1/app_settings')) {
    if (method === 'POST') {
      // upsert — one row or many
      for (const row of Array.isArray(body) ? body : [body]) settings[row.key] = row.value
      return json(Array.isArray(body) ? body : [body])
    }
    const keyEq = /[?&]key=eq\.([^&]+)/.exec(url)
    if (keyEq) {
      const k = keyEq[1]
      return json(k in settings ? { value: settings[k] } : null)
    }
    return json(Object.entries(settings).map(([key, value]) => ({ key, value })))
  }

  return json({})
}) as typeof fetch

function makeRes() {
  let status = 0
  let body: any = null
  const res: any = {
    setHeader() {},
    status(c: number) {
      status = c
      return res
    },
    json(v: unknown) {
      body = v
      return res
    },
    end() {
      return res
    },
  }
  return { res, get status() {
    return status
  }, get body() {
    return body
  } }
}

;(async () => {
  const adminSettings: Handler = (await import('../api/admin/settings/index')).default
  const publicSettings: Handler = (await import('../api/settings/index')).default

  console.log('\n-- the key is admitted to the allowlist --')
  {
    ok('booking_types is allowlisted', ALLOWED_SETTING_KEYS.has('booking_types'))
    // Being removed from the admin UI by the frontend, but the key stays: an
    // allowlist entry with no writer is inert, while a writer with no allowlist
    // entry is a 400 in someone's face.
    ok('book_a_call_url is still allowlisted', ALLOWED_SETTING_KEYS.has('book_a_call_url'))
  }

  console.log('\n-- PATCH round-trips the value --')
  {
    settings = {}
    const r = makeRes()
    await adminSettings(
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${await createSessionToken(ADMIN)}` },
        query: {},
        body: { booking_types: '["Discovery Call","Strategy Session"]' },
      },
      r.res
    )
    ok('admin PATCH is 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`)
    ok(
      'and the response carries the key back',
      r.body?.settings?.booking_types === '["Discovery Call","Strategy Session"]',
      JSON.stringify(r.body?.settings)
    )
  }

  console.log('\n-- the unauthenticated GET returns it: the item that decides this shipped --')
  // The public /book page has no session, so this endpoint is the only one it
  // can read. Note GET never consults ALLOWED_SETTING_KEYS — it returns every
  // stored row unfiltered — so what puts the key in this response is the ROW
  // existing, which the PATCH above created. An allowlist entry alone would
  // leave the key absent here.
  {
    const r = makeRes()
    await publicSettings({ method: 'GET', headers: {}, query: {}, body: undefined }, r.res)
    ok('public GET is 200', r.status === 200, `${r.status}`)
    ok('no authorization header was needed', true)
    ok(
      'booking_types is present in the flat object',
      r.body?.booking_types === '["Discovery Call","Strategy Session"]',
      JSON.stringify(r.body)
    )
    ok(
      'and it parses to the two labels',
      JSON.stringify(normalizeBookingTypes(r.body?.booking_types)) ===
        JSON.stringify(['Discovery Call', 'Strategy Session']),
      JSON.stringify(normalizeBookingTypes(r.body?.booking_types))
    )
  }

  console.log('\n-- before anything writes it, the key is simply absent --')
  // Worth pinning: the frontend has to treat "missing" as "no dropdown", not as
  // an error. Allowlisting a key does not create a row.
  {
    settings = {}
    const r = makeRes()
    await publicSettings({ method: 'GET', headers: {}, query: {}, body: undefined }, r.res)
    ok('GET still 200 with no row', r.status === 200, `${r.status}`)
    ok('booking_types is undefined, not null or ""', r.body?.booking_types === undefined, JSON.stringify(r.body))
    ok('and normalizing undefined gives an empty list', normalizeBookingTypes(r.body?.booking_types).length === 0)
  }

  console.log('\n-- malformed values degrade to no dropdown, never a throw --')
  {
    // The three the brief names.
    ok('a bare string that is not JSON -> []', JSON.stringify(normalizeBookingTypes('Discovery Call')) === '[]')

    // DELIBERATE READING, worth stating because the brief points two ways on
    // this one case. Acceptance 3 says a malformed value "normalizes to an empty
    // list"; the normalizer spec says to "skip malformed entries rather than
    // throwing" and to match normalizeBookingQuestions, which filters bad entries
    // and keeps the good ones. Entry-skipping wins: "skip malformed entries" only
    // means anything if partial arrays survive, and the named precedent behaves
    // exactly that way. So a top-level malformed value gives [], while a good
    // array with one bad entry keeps the good entries.
    //
    // Both readings are safe for a visitor — the difference is whether one
    // fat-fingered entry costs the admin the whole dropdown or just that entry.
    // Flip this assertion to '[]' if the whole-array rejection was intended.
    ok(
      'an array containing a number -> the number is skipped, the labels survive',
      JSON.stringify(normalizeBookingTypes('["Discovery Call",3]')) === '["Discovery Call"]',
      JSON.stringify(normalizeBookingTypes('["Discovery Call",3]'))
    )
    ok('valid JSON that is an object, not an array -> []', JSON.stringify(normalizeBookingTypes('{"a":"b"}')) === '[]')

    // And the rest of the space, since "does not crash" is the actual contract.
    ok('null -> []', JSON.stringify(normalizeBookingTypes(null)) === '[]')
    ok('undefined -> []', JSON.stringify(normalizeBookingTypes(undefined)) === '[]')
    ok('empty string -> []', JSON.stringify(normalizeBookingTypes('')) === '[]')
    ok('empty array -> []', JSON.stringify(normalizeBookingTypes('[]')) === '[]')
    ok('a number -> []', JSON.stringify(normalizeBookingTypes(42)) === '[]')
    ok('truncated JSON -> []', JSON.stringify(normalizeBookingTypes('["Discovery')) === '[]')
    ok(
      'whitespace-only entries are dropped',
      JSON.stringify(normalizeBookingTypes('["  ","Strategy Session"]')) === '["Strategy Session"]',
      JSON.stringify(normalizeBookingTypes('["  ","Strategy Session"]'))
    )
    ok(
      'surviving labels are trimmed',
      JSON.stringify(normalizeBookingTypes('["  Discovery Call  "]')) === '["Discovery Call"]'
    )
    ok(
      'nested arrays and objects inside are skipped, not flattened',
      JSON.stringify(normalizeBookingTypes('[["a"],{"b":1},"Real One"]')) === '["Real One"]',
      JSON.stringify(normalizeBookingTypes('[["a"],{"b":1},"Real One"]'))
    )
    // Already-parsed input, since a caller reading a jsonb column would pass this.
    ok(
      'an already-parsed array works too',
      JSON.stringify(normalizeBookingTypes(['Discovery Call'])) === '["Discovery Call"]'
    )
  }

  console.log('\n-- the write path is still guarded --')
  {
    settings = {}
    const nonAdmin = makeRes()
    await adminSettings(
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${await createSessionToken(MEMBER)}` },
        query: {},
        body: { booking_types: '["Discovery Call"]' },
      },
      nonAdmin.res
    )
    ok('a non-admin PATCH is 403', nonAdmin.status === 403, `${nonAdmin.status}`)
    ok('and nothing was written', settings.booking_types === undefined, JSON.stringify(settings))

    const unknown = makeRes()
    await adminSettings(
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${await createSessionToken(ADMIN)}` },
        query: {},
        body: { booking_typos: '["Discovery Call"]' },
      },
      unknown.res
    )
    ok('an unknown key is 400', unknown.status === 400, `${unknown.status}`)
    // The message is `unknown setting '<key>'`, not `invalid_field`.
    ok(
      'named in the message so the admin can see which field',
      unknown.body?.error === "unknown setting 'booking_typos'",
      JSON.stringify(unknown.body)
    )

    const nonString = makeRes()
    await adminSettings(
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${await createSessionToken(ADMIN)}` },
        query: {},
        body: { booking_types: ['Discovery Call'] },
      },
      nonString.res
    )
    // The value must be a JSON STRING, not an array — app_settings.value is text.
    ok('an array value is refused', nonString.status === 400, `${nonString.status}`)
    ok(
      "and says it must be a string",
      nonString.body?.error === "value for 'booking_types' must be a string",
      JSON.stringify(nonString.body)
    )
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
