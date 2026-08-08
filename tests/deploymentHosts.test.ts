// A PRODUCTION DEPLOYMENT HOLDING A PREVIEW URL.
//
// The class, not the instance. GOOGLE_REDIRECT_URI pointed at the raw Vercel
// deployment host for sixteen days — registered on the client, so it worked
// perfectly, and the only person who saw the symptom was a coach reading
// `client-atm-api-<account>-<team>.vercel.app` on the consent screen.
//
// EVERY AXIS IS VARIED ALONE. A warning that always fires and one that never
// fires are indistinguishable from a single case; only the spread separates
// them, so environment and host are each moved independently with the other
// held constant.

process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend'

import { warnIfDeploymentHost, _resetDeploymentHostWarningsForTests } from '../lib/deploymentHosts'

let pass = 0,
  fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}
function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const DEPLOY = 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app/api/calendar/google/callback'
const STABLE = 'https://api.microtrainingmethod.com/api/calendar/google/callback'

const realWarn = console.warn
let captured: string[] = []
console.warn = (...a: unknown[]) => { captured.push(a.map(String).join(' ')) }

function run(vercelEnv: string | undefined, entries: Array<[string, string | null | undefined]>) {
  captured = []
  _resetDeploymentHostWarningsForTests()
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = vercelEnv
  for (const [name, value] of entries) warnIfDeploymentHost(name, value)
  return captured
}

;(async () => {
  console.log('\n-- the one case that must warn --')
  {
    const out = run('production', [['GOOGLE_REDIRECT_URI', DEPLOY]])
    eq('production + deployment host warns once', out.length, 1)
    // NAMES THE VARIABLE AND THE VALUE. "A URL is misconfigured" without saying
    // which one costs the next reader the same search that produced this code.
    ok('names the variable', out[0].includes('GOOGLE_REDIRECT_URI'), out[0])
    ok('and the offending value', out[0].includes('client-atm-api-workwithjamaul-4008s-projects.vercel.app'), out[0])
    ok('and says it is production', /PRODUCTION/.test(out[0]))
    ok('and why it matters', /consent screen|email/i.test(out[0]))
  }

  console.log('\n-- each axis moved ALONE, so a check ignoring either is caught --')
  {
    // Host varies, environment held at production.
    eq('production + stable host is silent', run('production', [['APP_URL', STABLE]]).length, 0)
    // Environment varies, host held at the deployment URL.
    eq('preview + deployment host is silent — correct there', run('preview', [['APP_URL', DEPLOY]]).length, 0)
    eq('development likewise', run('development', [['APP_URL', DEPLOY]]).length, 0)
    eq('and an unset VERCEL_ENV is silent', run(undefined, [['APP_URL', DEPLOY]]).length, 0)
  }

  console.log('\n-- EVERY wrong variable is named, not just the first --')
  {
    // A single global flag would let the first silence the second, and the
    // second is the one nobody knows about.
    const out = run('production', [
      ['APP_URL', DEPLOY],
      ['API_URL', DEPLOY],
      ['GOOGLE_REDIRECT_URI', DEPLOY],
    ])
    eq('three wrong variables, three warnings', out.length, 3)
    ok('APP_URL named', out.some((l) => l.includes('APP_URL')))
    ok('API_URL named', out.some((l) => l.includes('API_URL')))
    ok('GOOGLE_REDIRECT_URI named', out.some((l) => l.includes('GOOGLE_REDIRECT_URI')))
  }

  console.log('\n-- once per instance, not once per call --')
  {
    captured = []
    _resetDeploymentHostWarningsForTests()
    process.env.VERCEL_ENV = 'production'
    for (let i = 0; i < 5; i++) warnIfDeploymentHost('APP_URL', DEPLOY)
    eq('five calls, one warning', captured.length, 1)
  }

  console.log('\n-- it never throws, whatever it is handed --')
  {
    for (const v of ['not a url', '', null, undefined, 'ftp://x', 'https://']) {
      let threw = false
      try { run('production', [['X', v as any]]) } catch { threw = true }
      ok(`survives ${JSON.stringify(v)}`, !threw)
    }
    eq('and an unparseable value warns about nothing', run('production', [['X', 'not a url']]).length, 0)
    // A host that merely CONTAINS the suffix is not on it. `foo.vercel.app.evil.com`
    // is somebody else's domain, and flagging it would be a false positive that
    // teaches people to ignore the line.
    //
    // THIS FIXTURE HAS TO CONTAIN `.vercel.app` AND NOT END WITH IT, or it cannot
    // tell the difference it exists to tell. The first version of it was
    // `vercel.app.example.com` — no leading dot, so it does not contain the
    // suffix either, and `endsWith` and `includes` behave identically on it.
    // Mutating `endsWith` to `includes` left the suite green, which is what a
    // decorative guard looks like from the inside.
    eq('a lookalike host does not warn', run('production', [['X', 'https://foo.vercel.app.evil.com/x']]).length, 0)
    // And the weaker version of the same trap: not even a substring.
    eq('an unrelated host does not warn', run('production', [['X', 'https://vercel.app.example.com/x']]).length, 0)
    // Whereas a bare deployment host with no path does.
    eq('a deployment host with no path does warn', run('production', [['X', 'https://foo-bar.vercel.app']]).length, 1)
  }

  console.log('\n-- the API_URL default no longer points at a deployment host --')
  {
    // THE LIVE RISK, and the reason this widened past GOOGLE_REDIRECT_URI:
    // API_URL builds the magic-link login URL and the nurture unsubscribe link,
    // and its default was hardcoded to the Vercel deployment URL in three files.
    // An email is permanent in a way a consent screen is not.
    const { readFileSync } = await import('fs')
    for (const f of ['lib/appUrls.ts', 'lib/email.ts', 'lib/funnelNurture.ts', 'lib/avatars.ts']) {
      ok(`${f} hardcodes no deployment URL`, !/client-atm-api-[a-z0-9-]*\.vercel\.app/.test(readFileSync(f, 'utf8')), 'a preview host is baked into source')
    }
    // ONE OWNER. Three copies of the same const is how the defaults drifted.
    const copies = ['lib/email.ts', 'lib/funnelNurture.ts', 'lib/avatars.ts'].filter((f) =>
      /const API_URL\s*=/.test(readFileSync(f, 'utf8'))
    )
    eq('API_URL is declared in exactly one place', copies, [])
    ok('and that place is lib/appUrls.ts', /export const API_URL/.test(readFileSync('lib/appUrls.ts', 'utf8')))
  }

  console.warn = realWarn
  delete process.env.VERCEL_ENV
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
