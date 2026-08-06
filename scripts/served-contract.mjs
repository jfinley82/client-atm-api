// Generates docs/served-contract.md — the exact key names, types and sections
// the Steps 1-3 output panels read.
//
// GENERATED, NOT TRANSCRIBED. A hand-written contract is a fifth place for a
// name to drift, next to the model's raw fields, the deriver, the panel and the
// design spec. This runs the REAL deriveAudienceDisplayFields and reports what
// actually comes out; when the derived set changes, this regenerates and
// tests/servedContract.test.ts fails until the committed file matches.
//
// NO CUSTOMER DATA. The Attract shape comes from running the deriver over a
// synthetic probe — key names and types are properties of the CODE, not of
// anyone's content. The Transform/Monetize key lists were read from production
// saved_outputs KEY NAMES only (jsonb_object_keys), never values, and are pinned
// in TOOL_KEYS below because those tool_types have no deriver to introspect.
//
// Usage:  node scripts/served-contract.mjs           # write docs/served-contract.md
//         node scripts/served-contract.mjs --check   # exit 1 if the file is stale
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outPath = path.join(root, 'docs', 'served-contract.md')

// ---------------------------------------------------------------------------
// 1. Bundle api/tools/chat.ts so the real deriver can be called.
//    --packages=external for the reason scripts/run-tests.mjs documents: an
//    inlined dependency reading import.meta at module scope breaks.
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.contract-'))
const bundle = path.join(tmpDir, 'chat.cjs')
const build = spawnSync(
  'npx',
  ['esbuild', 'api/tools/chat.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external', `--outfile=${bundle}`],
  { cwd: root, encoding: 'utf8' }
)
if (build.status !== 0) {
  console.error(build.stderr || build.stdout)
  process.exit(1)
}
process.env.ANTHROPIC_API_KEY ||= 'stub'
process.env.SUPABASE_URL ||= 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub'
const { createRequire } = await import('node:module')
const require_ = createRequire(import.meta.url)
const { deriveAudienceDisplayFields } = require_(bundle)

// ---------------------------------------------------------------------------
// 2. Discover which raw keys the deriver reads, by reading its source.
//    Generated rather than listed, so a new `raw.something` is picked up.
// ---------------------------------------------------------------------------
const chatSrc = fs.readFileSync(path.join(root, 'api', 'tools', 'chat.ts'), 'utf8')
const fnStart = chatSrc.indexOf('export function deriveAudienceDisplayFields')
const fnEnd = chatSrc.indexOf('\n}', fnStart)
const fnSrc = chatSrc.slice(fnStart, fnEnd)
const rawKeys = [...new Set([...fnSrc.matchAll(/\braw\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]))].sort()

// ---------------------------------------------------------------------------
// 3. Run the deriver over probes of each shape and union the results. A derived
//    key only appears in the run whose shape it accepts, which is what tells us
//    its served type — so the type comes from behaviour, not from a guess.
// ---------------------------------------------------------------------------
const PROBE_STRING = '~probe~'
const shapes = {
  string: () => PROBE_STRING,
  'string[]': () => [PROBE_STRING],
  'object[]': () => [{ reframe: PROBE_STRING, monetization_hint: PROBE_STRING }],
}
const served = new Map() // servedName -> { type, from }
for (const [typeName, make] of Object.entries(shapes)) {
  const probe = Object.fromEntries(rawKeys.map((k) => [k, make()]))
  const out = deriveAudienceDisplayFields(probe)
  for (const [key, value] of Object.entries(out)) {
    const looksReal =
      (typeName === 'string' && value === PROBE_STRING) ||
      (typeName === 'string[]' && Array.isArray(value) && value.length > 0 && value[0] === PROBE_STRING) ||
      (typeName === 'object[]' && Array.isArray(value) && value.length > 0 && typeof value[0] === 'object')
    if (looksReal && !served.has(key)) served.set(key, { type: typeName })
  }
}
// avatar_gender is set unconditionally to an enum, so no probe shape "matches"
// it — record it from the actual output.
{
  const out = deriveAudienceDisplayFields({})
  for (const [key, value] of Object.entries(out)) {
    if (!served.has(key)) served.set(key, { type: typeof value === 'string' ? 'string (enum)' : typeof value })
  }
}

// ---------------------------------------------------------------------------
// 4. Which raw key each served key comes from, and which of the twelve spec
//    sections it feeds. The section names are prose from
//    spec-steps1-3-output-shell-redesign.md §14, so this mapping is authored —
//    but it is asserted complete in BOTH directions below, so a served key with
//    no section, or a section naming a key that is not served, fails here rather
//    than surfacing as a blank card.
// ---------------------------------------------------------------------------
const SECTIONS = {
  avatarName: ['Avatar hero', 'avatar_name'],
  avatar_gender: ['Avatar hero', 'avatar_gender (or inferred from avatarName)'],
  problemStatement: ['Avatar hero', 'problem_statement'],
  connectionSummary: ['Avatar hero', 'connection_summary'],
  perceivedProblem: ['The Gap', 'perceived_problem'],
  realProblem: ['The Gap', 'real_problem'],
  gapInsight: ['The Gap', 'gap_insight'],
  painPoints: ['Pain points', 'pain_points'],
  fearsAndDoubts: ['Fears & doubts', 'fears_and_doubts'],
  dreamOutcome: ['Dream outcome', 'dream_outcome'],
  motivatingStatements: ['The language they use', 'motivating_phrases'],
  turnAwayStatements: ['The language they use', 'repelling_phrases'],
  languageProblem: ['The language they use', 'language_problem'],
  languageSolution: ['The language they use', 'language_solution'],
  buyingDecisions: ['Buying triggers', 'buying_triggers'],
  objections: ['Objections & reframes', 'sales_objections'],
  pastAttempts: ["What they've tried", 'tried_before'],
  whereToFind: ['Where to find them', 'where_to_find_them'],
  otherAngles: ['Alternate angles', 'other_angles'],
  monetizeBridge: ['Monetize bridge', 'monetize_bridge'],
}

const unmapped = [...served.keys()].filter((k) => !SECTIONS[k])
const unserved = Object.keys(SECTIONS).filter((k) => !served.has(k))
if (unmapped.length || unserved.length) {
  console.error('Section map is out of step with the deriver.')
  if (unmapped.length) console.error('  served but unmapped:', unmapped.join(', '))
  if (unserved.length) console.error('  mapped but not served:', unserved.join(', '))
  process.exit(1)
}

// The four whose served name is NOT a camelisation of the raw key — computed,
// so the callout cannot go stale if one is renamed.
const camelise = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const surprises = [...served.keys()]
  .filter((k) => SECTIONS[k])
  .map((k) => ({ servedName: k, rawKey: SECTIONS[k][1].split(' ')[0] }))
  .filter(({ servedName, rawKey }) => camelise(rawKey) !== servedName && servedName !== rawKey)

// ---------------------------------------------------------------------------
// 5. Transform and Monetize. No deriver exists for these tool_types — what the
//    model writes is what is stored and served — so there is no camelCase
//    display set to discover. The trap is different and is spelled out below.
//    Key names read from production saved_outputs via jsonb_object_keys.
// ---------------------------------------------------------------------------
const TOOL_KEYS = {
  transformation: 'after_internal_talk, after_results, after_state, before_internal_talk, before_results, before_state, client_language_after, client_language_before, completed, proof_point, session_history, the_bridge',
  transformation_analysis: 'afterState, beforeState, confirmed, intersection, selected_id, selectedProblems, sync_snapshot, uniquelyEquipped, zoneOfImpact',
  matcher_intake: 'completed, delivery, format, has_existing_offer, price, session_history',
  matcher_analysis: 'insights, recommended_ids, selected_ids, suggested_offers, top_10, why_recommended',
  program: 'confirmed, deliverables, program_name, session_length_minutes, session_type, suggested_capacity_per_month, suggested_starting_price, sync_snapshot, timeline_reasoning, total_sessions, total_weeks, weekly_breakdown',
  core_offers: 'confirmed, high_ticket, low_ticket, mid_ticket, next_step_bridge, sync_snapshot',
}

// ---------------------------------------------------------------------------
// 6. Emit.
// ---------------------------------------------------------------------------
const bySection = {}
for (const [name, { type }] of [...served.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const [section, rawKey] = SECTIONS[name]
  ;(bySection[section] ||= []).push({ name, type, rawKey })
}
const SECTION_ORDER = [
  'Avatar hero', 'The Gap', 'Pain points', 'Fears & doubts', 'Dream outcome',
  'The language they use', 'Buying triggers', 'Objections & reframes',
  "What they've tried", 'Where to find them', 'Alternate angles', 'Monetize bridge',
]

let md = `# The served contract for the Steps 1–3 output panels

**Generated by \`scripts/served-contract.mjs\` — do not edit by hand.** Regenerate
with \`node scripts/served-contract.mjs\`; \`tests/servedContract.test.ts\` fails if
this file drifts from the code.

The Attract table below is produced by running the real
\`deriveAudienceDisplayFields\` over a synthetic probe, so every name and type here
is a property of the shipped code rather than a transcription. No customer data
is involved.

---

## The rule that matters most

**The raw snake_case fields and the derived camelCase fields are NOT duplicates,
and must not be collapsed.**

They live in the same object and look like duplication. They are not. The raw
fields are canonical and are what the Funnel Builder's MTM Adapter consumes; the
camelCase set is the display subset the panel reads, derived server-side so there
is exactly one renderer shape. \`api/tools/results.ts\` derives the same subset on
the finalized profile for the same reason.

\`spec-steps1-3-output-shell-redesign.md\` §19 says *"Many keys duplicated in
camelCase — dedupe on build."* **That line is superseded.** It predates the
handler contract by a week, and following it deletes the keys the panel reads.
Deriving your own camelCase from the raw fields is the same mistake wearing a
different hat: it creates a second renderer that drifts from the served one.

## The ${surprises.length} names a reasonable person guesses wrong

These served names are **not** camelisations of their raw key. Guessing the
camelised form returns \`undefined\` and renders a blank card with no error — which
is exactly how The Gap card failed before \`perceivedProblem\`/\`realProblem\` were
added.

| raw key | served name | the wrong guess |
|---|---|---|
`
for (const { servedName, rawKey } of surprises) {
  md += `| \`${rawKey}\` | **\`${servedName}\`** | ~~\`${camelise(rawKey)}\`~~ |\n`
}

md += `
## The one deliberate snake_case exception

\`avatar_gender\` is served **snake_case even in the derived set**, and that is on
purpose. It is set unconditionally — \`genderFromName\` falls back to a safe
\`'neutral'\` — so the profile always carries a valid value for gender-matched
avatar selection on read. Everything else in the derived set is camelCase and is
omitted when empty; this one is neither, so it is called out rather than left as
a surprise.

---

## Step 1 Attract — \`saved_outputs.content\` where \`tool_type = 'audience'\`

Read these. ${served.size} keys, across the twelve sections of §14.

`
for (const section of SECTION_ORDER) {
  const rows = bySection[section]
  if (!rows) continue
  md += `### ${section}\n\n| served name | type | derived from |\n|---|---|---|\n`
  for (const r of rows) md += `| \`${r.name}\` | ${r.type} | \`${r.rawKey}\` |\n`
  md += '\n'
}

md += `> Every key above is **omitted when it has no content** (the one exception is
> \`avatar_gender\`). Absent means "not established yet in the conversation", not
> "empty" — render the section's not-yet state rather than an empty card.

---

## Steps 2 and 3 — there is no derived set, and that is the trap

\`audience\` is the only \`tool_type\` with a display deriver. For Transform and
Monetize, **what the model writes is what is stored and what is served** — so
there is no camelCase subset to look for, and asking for one returns
\`undefined\`.

The trap here is the opposite shape: **the convention is not consistent between
tool_types, and one panel reads several.**

- \`transformation\` is **entirely snake_case**.
- \`transformation_analysis\` is **mixed**: \`zoneOfImpact\`, \`selectedProblems\`,
  \`uniquelyEquipped\`, \`intersection\`, \`beforeState\`, \`afterState\` are camelCase,
  while \`selected_id\`, \`sync_snapshot\` and \`confirmed\` are snake_case.
- Every Monetize source is **entirely snake_case**.

Note especially that **\`beforeState\`/\`afterState\` and \`before_state\`/\`after_state\`
are different keys in different tool_types**, both feeding the Transform panel.
Reading the camelCase pair from \`transformation\`, or the snake_case pair from
\`transformation_analysis\`, returns \`undefined\` in both directions.

Key names below are read from production \`saved_outputs\` via
\`jsonb_object_keys\` — names only, never values.

`
for (const [tool, keys] of Object.entries(TOOL_KEYS)) {
  md += `**\`${tool}\`**\n\n${keys.split(', ').map((k) => `\`${k}\``).join(' · ')}\n\n`
}

md += `\`completed\`, \`confirmed\`, \`session_history\`, \`sync_snapshot\`, \`selected_id\`
and \`selected_ids\` are bookkeeping the panel does not render.
`

const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null
if (process.argv.includes('--check')) {
  if (existing !== md) {
    console.error('docs/served-contract.md is stale — run: node scripts/served-contract.mjs')
    process.exit(1)
  }
  console.log('docs/served-contract.md is up to date.')
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, md)
  console.log(`Wrote ${outPath} — ${served.size} Attract keys, ${surprises.length} non-camelised names.`)
}
fs.rmSync(tmpDir, { recursive: true, force: true })
