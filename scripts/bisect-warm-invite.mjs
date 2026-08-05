#!/usr/bin/env node
// Bisect harness for "a generated email body comes back as one block".
//
// WHY THIS EXISTS. This class of bug is only observable in real model output,
// so every hypothesis has been costing a production regeneration on a real
// coach's account plus a manual count. Two hypotheses have already died that
// way (stale data; the format rule's wording/length loophole). This runs the
// same experiment locally, many variants at once, for the price of an API key.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/bisect-warm-invite.mjs
//   ANTHROPIC_API_KEY=sk-... node scripts/bisect-warm-invite.mjs --runs 3 --unit emails
//
// It sends the REAL system prompt for the unit — imported from
// lib/microTrainingGenerator, not a paraphrase — against fixture grounding, and
// reports blank-line counts per body. Variants mutate one thing each so a
// difference is attributable.
//
// Nothing here writes to the database or to a coach's row.

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is required. This harness calls the real model on purpose —')
  console.error('the bug is only visible in real output, which is why static review keeps missing it.')
  process.exit(2)
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const RUNS = Number(arg('runs', '3'))
const UNIT = arg('unit', 'warm_invite')

// Bundle the generator so the harness reads the REAL prompt strings. Output goes
// inside node_modules so --packages=external can still resolve deps (the same
// constraint scripts/run-tests.mjs works around, for the same reason).
const tmp = fs.mkdtempSync(path.join(root, 'node_modules', '.bisect-'))
const out = path.join(tmp, 'gen.cjs')
execFileSync('npx', [
  'esbuild', path.join(root, 'lib/microTrainingGenerator.ts'),
  '--bundle', '--platform=node', '--format=cjs', '--packages=external', `--outfile=${out}`,
], { stdio: ['ignore', 'ignore', 'inherit'], cwd: root })

const { UNIT_SPECS } = require(out)
const spec = UNIT_SPECS[UNIT]
if (!spec) {
  console.error(`unknown unit "${UNIT}". known: ${Object.keys(UNIT_SPECS).join(', ')}`)
  process.exit(2)
}

// Fixture grounding. Deliberately generic — the question is whether the PROMPT
// shape drives paragraphing, so the content should not be the interesting
// variable. Swap in a real card's grounding if you want to rule that out too.
const GROUNDING = `BLUEPRINT PROBLEM: Coaches with a warm audience who ask for free advice and then hire someone else.
AUDIENCE: Independent service-business coaches, 2-5 years in, list of 400-1200, no funnel.
TRANSFORMATION: From being the helpful friend in the DMs to being the obvious paid choice.
FRAMEWORK: The Signal Method — Name it, Frame it, Ask for it.
SUGGESTED OFFER: A 6-week group intensive.
CURRENT TRAINING TITLE: "Why your warmest followers never buy"
ANGLE: Your warmest followers ask you for advice, then pay someone else.`

// Each variant changes ONE thing about the system prompt so a difference in the
// result is attributable to that thing. `baseline` is what is deployed today.
const VARIANTS = {
  baseline: (p) => p,

  // Hypothesis under test: the body field spec's SHAPE is mimicked. A spec
  // written as one flowing sentence yields one flowing paragraph. Restores the
  // pre-fix prose spec, so a WORSE result here confirms the shape mattered.
  prose_field_spec: (p) =>
    p.replace(
      /"body": "\.\.\."/g,
      '"body": "lead with the reader\'s problem in \'you\' language, tease the training\'s payoff, invite them to register. End with the opt-in CTA using [REGISTER_LINK]."'
    ),

  // Does an explicit shape in the spec beat an instruction anywhere else?
  demonstrated_field_spec: (p) =>
    p.replace(/"body": "\.\.\."/g, '"body": "first paragraph.\\n\\nsecond paragraph.\\n\\nthird paragraph."'),

  // Is the floor being read at all, or is it lost among the other rules?
  no_format_rule: (p) => p.replace(/^- Format each body per the email canonical:.*$/m, ''),

  // Recency: the format rule currently sits before the hook reminder and the
  // shared rules. Does it land differently as the LAST thing read?
  format_rule_last: (p) =>
    p.replace(/^- Format each body per the email canonical:(.*)$/m, '') +
    '\n\nFORMATTING, checked last before you return: every body is at least 3 paragraphs separated by blank lines. One paragraph is never correct.',
}

async function generate(system) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: spec.maxTokens,
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: `${GROUNDING}\n\nGenerate the ${UNIT} asset now.` }],
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const json = await res.json()
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  const start = text.indexOf('{')
  const parsed = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1))
  const list = parsed[Object.keys(parsed)[0]]
  return (Array.isArray(list) ? list : []).map((e) => String(e?.body ?? ''))
}

const results = []
for (const [name, mutate] of Object.entries(VARIANTS)) {
  const system = mutate(spec.prompt)
  const unchanged = system === spec.prompt && name !== 'baseline'
  if (unchanged) {
    console.log(`SKIP ${name} — mutation matched nothing; the prompt shape moved under it.`)
    continue
  }
  for (let run = 1; run <= RUNS; run++) {
    try {
      const bodies = await generate(system)
      const counts = bodies.map((b) => (b.match(/\n\s*\n/g) || []).length)
      const chars = bodies.map((b) => b.length)
      results.push({ name, run, counts, chars })
      console.log(`${name} run ${run}: blank lines ${counts.join(', ')}  (chars ${chars.join(', ')})`)
    } catch (err) {
      console.log(`${name} run ${run}: ERROR ${err.message.slice(0, 120)}`)
    }
  }
}

console.log('\n=== summary: mean blank lines per body ===')
for (const name of Object.keys(VARIANTS)) {
  const rows = results.filter((r) => r.name === name)
  if (!rows.length) continue
  const all = rows.flatMap((r) => r.counts)
  const mean = all.reduce((a, b) => a + b, 0) / all.length
  const zero = all.filter((c) => c === 0).length
  console.log(`${name.padEnd(24)} mean ${mean.toFixed(2)}   one-block bodies ${zero}/${all.length}`)
}
console.log('\nA variant whose one-block count drops to 0/N is the lever. If every variant')
console.log('is 0/N or every variant fails, the cause is not in this unit\'s prompt text.')

fs.rmSync(tmp, { recursive: true, force: true })
