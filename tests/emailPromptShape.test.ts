process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'stub-anthropic-key'

import { UNIT_SPECS } from '../lib/microTrainingGenerator'

// These pin the INDEPENDENT VARIABLE of a live experiment, nothing more.
//
// warm_invite emails come back as one unbroken block while emails and
// book_a_call do not. Two hypotheses are already dead (stale data; a wording
// loophole in the format rule), both killed by regeneration rather than
// argument. The current one: the body field spec's SHAPE is mimicked — a spec
// written as one flowing sentence produces one flowing paragraph, and
// warm_invite was the only unit phrased that way.
//
// So warm_invite's spec now matches book_a_call's, the best performer. If a
// later edit reintroduces prose there, the experiment is silently contaminated
// and nobody would know. That is what these assertions catch. They do NOT
// assert the hypothesis is correct — only regeneration can, via
// scripts/bisect-warm-invite.mjs.

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const EMAIL_UNITS = ['warm_invite', 'emails', 'book_a_call'] as const
const bodySpecs = (prompt: string) => [...prompt.matchAll(/"body": "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])

console.log('\n-- warm_invite no longer describes the body as one flowing sentence --')
{
  const specs = bodySpecs(UNIT_SPECS.warm_invite.prompt)
  ok('has three body specs', specs.length === 3, JSON.stringify(specs))
  ok('each is the bare placeholder, as book_a_call already was', specs.every((s) => s === '...'), JSON.stringify(specs))
  ok(
    'the per-email job survived the move into the rules',
    /Each email's job, in order:/.test(UNIT_SPECS.warm_invite.prompt),
    'the jobs were deleted rather than relocated — content lost, not just reshaped'
  )
  for (const beat of ['announces the training', 'goes deeper on the specific result', 'is the last call']) {
    ok(`job retained: ${beat}`, UNIT_SPECS.warm_invite.prompt.includes(beat))
  }
  ok('send_timing still carries the schedule', /day 1, announce the training/.test(UNIT_SPECS.warm_invite.prompt))
  ok('the CTA token is still specified', /\[REGISTER_LINK\]/.test(UNIT_SPECS.warm_invite.prompt))
}

console.log('\n-- the format floor is present and identical across all three email units --')
{
  const lines = EMAIL_UNITS.map((u) => /^- Format each body per the email canonical:.*$/m.exec(UNIT_SPECS[u].prompt)?.[0] ?? '')
  ok('every email unit carries the rule', lines.every((l) => l.length > 0), JSON.stringify(lines.map((l) => l.slice(0, 40))))
  ok('and they are byte-identical', new Set(lines).size === 1, `${new Set(lines).size} distinct variants`)
  ok('the rule states a countable floor', /AT LEAST 3 paragraphs/.test(lines[0]), lines[0])
  ok('and binds on short bodies', /floor applies to SHORT bodies/i.test(lines[0]), lines[0])
}

console.log('\n-- the bisect harness can still find what it mutates --')
// scripts/bisect-warm-invite.mjs rewrites these exact substrings. If the prompt
// moves under it the harness silently measures nothing, so the anchors are
// pinned here rather than discovered at 2am mid-experiment.
{
  ok('harness anchor: bare body placeholder exists', /"body": "\.\.\."/.test(UNIT_SPECS.warm_invite.prompt))
  ok('harness anchor: format rule line exists', /^- Format each body per the email canonical:/m.test(UNIT_SPECS.warm_invite.prompt))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
