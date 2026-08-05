// One value for where the app lives, asserted at the only two places it can
// drift: the constant's own default, and the files that used to declare their
// own. Four copies of `const APP_URL = process.env.APP_URL || …` disagreed
// about the default, and that disagreement is how the AI coach handoff URL
// got the wrong host twice.

import fs from 'fs'
import path from 'path'

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const CONSUMERS = [
  'api/auth/callback.ts',
  'api/calendar/google/callback.ts',
  'api/calendar/google/connect.ts',
  'lib/email.ts',
  'api/funnel/application.ts',
]

console.log('\n-- the app base is declared exactly once --')
{
  const src = read('lib/appUrls.ts')
  ok('appUrls declares APP_URL', /export const APP_URL\s*=/.test(src))
  ok('with the post-cutover host as its default', src.includes("'https://app.microtrainingmethod.com'"), src.slice(0, 200))
  ok('and the env var still wins', /process\.env\.APP_URL \|\|/.test(src))

  // Any file re-declaring it re-introduces the drift this module removes.
  for (const f of CONSUMERS) {
    const s = read(f)
    ok(`${f} does not re-declare APP_URL`, !/const APP_URL\s*=\s*process\.env/.test(s), 'local declaration found — the defaults can diverge again')
  }
}

console.log('\n-- the coach shell base cannot drift from it --')
{
  const src = read('lib/appUrls.ts')
  ok('COACH_SHELL_URL is declared beside it', /export const COACH_SHELL_URL\s*=/.test(src))
  ok('and falls back to APP_URL, not a literal', /COACH_SHELL_URL\s*=\s*process\.env\.COACH_SHELL_URL \|\| APP_URL/.test(src), 'a hardcoded literal here is the exact defect that shipped twice')
  ok('application.ts imports it rather than defining one', /import \{[^}]*COACH_SHELL_URL[^}]*\} from '\.\.\/\.\.\/lib\/appUrls'/.test(read('api/funnel/application.ts')))
  ok('and no longer declares its own', !/const COACH_SHELL_URL\s*=/.test(read('api/funnel/application.ts')))
}

console.log('\n-- appUrl() joins without doubling or dropping the slash --')
{
  // The handoff builds `<base>/coach?t=…`; a trailing slash on the env var
  // would otherwise produce //coach.
  const { appUrl } = require(path.join(process.cwd(), 'lib/appUrls.ts')) as { appUrl: (b: string, p: string) => string }
  ok('plain base', appUrl('https://a.example', 'coach') === 'https://a.example/coach')
  ok('trailing slash on the base', appUrl('https://a.example/', 'coach') === 'https://a.example/coach')
  ok('several trailing slashes', appUrl('https://a.example///', 'coach') === 'https://a.example/coach')
  ok('leading slash on the path', appUrl('https://a.example', '/coach') === 'https://a.example/coach')
  ok('both', appUrl('https://a.example/', '/coach') === 'https://a.example/coach')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
