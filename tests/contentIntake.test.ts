process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'stub-anthropic-key'

import { resolveIntakeDefaults } from '../lib/contentAnalysis'

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

console.log('\n-- tone is still a real lever --')
ok('professional honoured', resolveIntakeDefaults({ tone: 'professional' }).tone === 'professional')
ok('casual honoured', resolveIntakeDefaults({ tone: 'casual' }).tone === 'casual')
ok('direct honoured', resolveIntakeDefaults({ tone: 'direct' }).tone === 'direct')
ok('unknown tone falls back to direct', resolveIntakeDefaults({ tone: 'shouty' }).tone === 'direct')
ok('missing tone falls back to direct', resolveIntakeDefaults({}).tone === 'direct')

console.log('\n-- platform is accepted in every shape and never shapes output --')
// The whole point: one caption renders inside every selected platform shell, so
// the intake cannot steer copy toward one of them. These must not throw and must
// not surface a platform the caller could act on.
const shapes: Array<[string, unknown]> = [
  ['a legacy single string', 'Instagram'],
  ['the new multi-select array', ['LinkedIn', 'Instagram', 'Facebook']],
  ['a single-item array', ['LinkedIn']],
  ['an empty array', []],
  ['null', null],
  ['a number', 7],
  ['an object', { linkedin: true }],
  ['undefined', undefined],
]
for (const [label, value] of shapes) {
  const resolved = resolveIntakeDefaults({ platform: value, tone: 'casual' }) as Record<string, unknown>
  ok(`${label}: does not throw and keeps tone`, resolved.tone === 'casual')
  ok(`${label}: exposes NO platform to steer copy`, !('platform' in resolved), JSON.stringify(resolved))
}

console.log('\n-- the resolved shape is tone-only --')
ok('exactly one key', Object.keys(resolveIntakeDefaults({ tone: 'direct' })).length === 1)
ok('and it is tone', Object.keys(resolveIntakeDefaults({ tone: 'direct' }))[0] === 'tone')

console.log('\n-- the prompt itself no longer writes for one platform --')
// Guarding the prompt text directly: this is the actual fix, and a future edit
// that reintroduces per-platform copy would otherwise pass every other test.
import fs from 'fs'
import path from 'path'
// Resolved from cwd (the gate runs from the repo root), NOT import.meta.url —
// esbuild's --format=cjs empties import.meta, which is the documented gotcha in
// CLAUDE.md and exactly what this line tripped on first time.
const src = fs.readFileSync(path.join(process.cwd(), 'lib/contentAnalysis.ts'), 'utf8')
const promptStart = src.indexOf('const CONTENT_PROMPT')
const promptEnd = src.indexOf('function asString')
const prompt = src.slice(promptStart, promptEnd)

ok('prompt says PLATFORM-NEUTRAL', /PLATFORM-NEUTRAL/.test(prompt))
ok('prompt names all three shells', /LinkedIn/.test(prompt) && /Instagram/.test(prompt) && /Facebook/.test(prompt))
ok('prompt bans "link in bio"', /link in bio/i.test(prompt))
ok('prompt requires a front-loaded hook for truncation', /front-load/i.test(prompt))
ok('prompt requires SHORT PARAGRAPHS in captions', /SHORT PARAGRAPHS/.test(prompt))
ok('prompt names the 1-3 sentence size', /1-3 sentences/.test(prompt))
ok('prompt says never one solid block', /never one solid block/i.test(prompt))
ok('prompt shows the literal blank-line escape', /\\\\n\\\\n/.test(prompt), prompt.match(/.*blank line.*/)?.[0])
ok('the caption field spec also carries the paragraph rule', /Short paragraphs separated by a blank line/.test(prompt))

console.log('\n-- the 5 email bodies get the same paragraph rule --')
// Captions shipped with this rule first; the emails in the SAME prompt did not,
// so a coach got readable posts and a wall-of-text welcome email. Both halves of
// the output are pinned here so they cannot drift apart again.
ok('a rule names the email BODY specifically', /email BODY/.test(prompt))
ok(
  'the email rule carries the same 1-3 sentence size',
  (prompt.match(/1-3 sentences/g) ?? []).length >= 2,
  `found ${(prompt.match(/1-3 sentences/g) ?? []).length} occurrences, expected one for captions and one for emails`
)
ok(
  'the email rule shows the literal blank-line escape too',
  (prompt.match(/\\\\n\\\\n/g) ?? []).length >= 2,
  `found ${(prompt.match(/\\\\n\\\\n/g) ?? []).length} occurrences`
)
ok(
  'the email rule says never one solid block',
  (prompt.match(/never one solid block/gi) ?? []).length >= 2,
  `found ${(prompt.match(/never one solid block/gi) ?? []).length} occurrences`
)
ok('greeting and sign-off are called out as their own paragraphs', /greeting line and the sign-off/i.test(prompt))
ok('the body field spec carries the paragraph rule', /ready-to-send email body\. Short paragraphs/.test(prompt))
ok(
  'prompt no longer instructs writing in the requested PLATFORM',
  !/in the requested platform/i.test(prompt),
  prompt.match(/.*requested platform.*/i)?.[0]
)
ok(
  'the caption field spec no longer says "for the given platform"',
  !/written for the given platform/i.test(prompt),
  prompt.match(/.*given platform.*/i)?.[0]
)

console.log('\n-- the user message carries tone but not platform --')
const genStart = src.indexOf('export async function generateContent')
const genEnd = src.indexOf('const message = await anthropic.messages.create', genStart)
const userMessage = src.slice(genStart, genEnd)
ok('TONE is still passed', /TONE: \$\{tone\}/.test(userMessage))
ok('PLATFORM is no longer passed', !/PLATFORM: /.test(userMessage), userMessage.match(/.*PLATFORM.*/)?.[0])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
