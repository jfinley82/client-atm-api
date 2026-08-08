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

// `env` is what process.env holds for the variables under test, which is the
// thing the origin sentence reports. It is cleared between runs so a case that
// sets a variable cannot make the NEXT case read as "set" — the same reason the
// warned-set is reset.
function run(
  vercelEnv: string | undefined,
  entries: Array<[string, string | null | undefined]>,
  env: Record<string, string | undefined> = {}
) {
  captured = []
  _resetDeploymentHostWarningsForTests()
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = vercelEnv
  const touched = new Set([...entries.map(([n]) => n), ...Object.keys(env)])
  for (const k of touched) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
  for (const [name, value] of entries) warnIfDeploymentHost(name, value)
  for (const k of touched) delete process.env[k]
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

  console.log('\n-- the line says whether the variable is SET or FALLING BACK --')
{
  // A VALUE CANNOT ANSWER THIS, and the answer sends the reader to a different
  // place in the dashboard: add a variable, or edit one. The two cases below are
  // identical in every respect except whether process.env holds the name — hold
  // one variable at a time, or neither assertion is about the thing it names.
  const setLine = run('production', [['API_URL', DEPLOY]], { API_URL: DEPLOY })[0] || ''
  const fallbackLine = run('production', [['API_URL', DEPLOY]], {})[0] || ''

  ok('set: says IS SET', /API_URL IS SET to this value/.test(setLine), setLine)
  ok('set: does not say unset', !/IS NOT SET/.test(setLine), setLine)
  ok('fallback: says IS NOT SET', /API_URL IS NOT SET/.test(fallbackLine), fallbackLine)
  ok('fallback: names it a fallback', /built-in fallback/.test(fallbackLine), fallbackLine)
  ok('fallback: does not say it is set', !/IS SET to this value/.test(fallbackLine), fallbackLine)

  // Both still carry the variable and the value, which is what the line was for
  // in the first place.
  for (const [label, line] of [['set', setLine], ['fallback', fallbackLine]] as const) {
    ok(`${label}: still names the variable`, line.includes('API_URL'), line)
    ok(`${label}: still names the value`, line.includes(DEPLOY), line)
  }

  // The third case, which exists because smoothing it into "set" would
  // misdescribe a value the caller transformed.
  const otherLine = run('production', [['API_URL', DEPLOY]], { API_URL: STABLE })[0] || ''
  ok('a differing env value is reported as its own case', /IS SET to https:\/\/api\.microtrainingmethod\.com/.test(otherLine), otherLine)
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

  console.log('\n-- API_URL has one owner, and that owner is checked --')
  {
    // THE LIVE RISK, and the reason this widened past GOOGLE_REDIRECT_URI:
    // API_URL builds the magic-link login URL and the nurture unsubscribe link,
    // and it was declared three times, each defaulting to the raw deployment
    // URL. An email is permanent in a way a consent screen is not.
    const { readFileSync, readdirSync } = await import('fs')

    // ONE OWNER, ASSERTED BY SWEEP RATHER THAN BY LIST.
    //
    // The first version of this named three files — lib/email.ts,
    // lib/funnelNurture.ts, lib/avatars.ts — which were the three I had found.
    // There were SEVEN. api/funnels/[id]/settings.ts, api/guide/refresh.ts,
    // api/pdf/document.ts and lib/bookingManage.ts each declared their own, and
    // a test that enumerates the instances it knows about is a census, not a
    // property: it goes green on the fix and stays green on the next copy.
    //
    // So walk the tree. The owner is allowed to declare it; nothing else is.
    const OWNER = 'lib/appUrls.ts'
    const sources: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) sources.push(p)
      }
    }
    walk('api'); walk('lib')

    const declarers = sources.filter((f) => /\bconst API_URL\s*=/.test(readFileSync(f, 'utf8')))
    eq('API_URL is declared in exactly one place', declarers, [OWNER])
    ok('and it is exported from there', /export const API_URL/.test(readFileSync(OWNER, 'utf8')))

    // And the value it defaults to appears nowhere else, so a future copy
    // pasting the literal is caught even if it names the const something else.
    const bakers = sources.filter(
      (f) => f !== OWNER && /client-atm-api-[a-z0-9-]*\.vercel\.app/.test(readFileSync(f, 'utf8'))
    )
    eq('and the deployment host is baked into no other source file', bakers, [])

    // NOT "the owner's default is a stable domain". That assertion existed for
    // one commit and was wrong: the stable-looking host it demanded,
    // api.microtrainingmethod.com, has no A record and is not on the Vercel
    // project, so satisfying it would have pointed every magic-link login at a
    // dead host. A test cannot check that a hostname resolves, and a default
    // that merely LOOKS stable is worse than an ugly one that works.
    //
    // What is checkable, and what actually matters, is that the value does not
    // escape the check. Every consumer imports it from here, and here calls
    // warnIfDeploymentHost on it — so the deployment-host default announces
    // itself on production rather than sitting in an inbox unnoticed.
    const owner = readFileSync('lib/appUrls.ts', 'utf8')
    for (const v of ['APP_URL', 'API_URL', 'COACH_SHELL_URL']) {
      ok(`${v} passes through warnIfDeploymentHost`, new RegExp(`warnIfDeploymentHost\\('${v}',`).test(owner))
    }
  }

  console.warn = realWarn
  delete process.env.VERCEL_ENV
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
