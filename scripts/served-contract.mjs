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
// in TOOL_SHAPES below because those tool_types have no deriver to introspect.
//
// Usage:  node scripts/served-contract.mjs           # write docs/served-contract.md
//         node scripts/served-contract.mjs --check   # exit 1 if the file is stale
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outPath = path.join(root, 'docs', 'served-contract.md')

// ---------------------------------------------------------------------------
// 1. Bundle lib/audienceDisplay.ts so the real deriver can be called. It moved
//    out of api/tools/chat.ts so read endpoints could use it without dragging in
//    the Anthropic client; bundling the lib directly also keeps this script off
//    that dependency.
//    --packages=external for the reason scripts/run-tests.mjs documents: an
//    inlined dependency reading import.meta at module scope breaks.
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.contract-'))
const bundle = path.join(tmpDir, 'audienceDisplay.cjs')
const build = spawnSync(
  'npx',
  ['esbuild', 'lib/audienceDisplay.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external', `--outfile=${bundle}`],
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

// The client-program serializers, bundled the same way and for the same reason:
// the contract is emitted by RUNNING them, so a renamed key fails the gate
// instead of reaching the frontend as a missing field.
const programBundle = path.join(tmpDir, 'clientProgramSerializers.cjs')
const buildPrograms = spawnSync(
  'npx',
  ['esbuild', 'lib/clientProgramSerializers.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external', `--outfile=${programBundle}`],
  { cwd: root, stdio: 'inherit' }
)
if (buildPrograms.status !== 0) {
  console.error('esbuild failed for lib/clientProgramSerializers.ts')
  process.exit(1)
}
const programSerializers = require_(programBundle)

// ---------------------------------------------------------------------------
// 2. Discover which raw keys the deriver reads, by reading its source.
//    Generated rather than listed, so a new `raw.something` is picked up.
// ---------------------------------------------------------------------------
const chatSrc = fs.readFileSync(path.join(root, 'lib', 'audienceDisplay.ts'), 'utf8')
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
// personaAvatarUrl is COMPUTED, not passed through, so no probe value "matches"
// it — it is recorded from the actual output below alongside avatar_gender.
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
// INNER SHAPES OF ARRAY-OF-OBJECT OUTPUTS, from the same probe run.
//
// Names-only at one level is what left the frontend rendering otherAngles with
// Object.values().filter(hasText) and printing whatever came back in key order —
// no idea which value is the reframe and which is the monetization hint. §19 of
// the redesign spec says the raw entries are reframe + monetization_hint, but
// six OUTER keys were renamed by the deriver in ways nobody would guess, so
// inner pass-through cannot be assumed either. Read from the actual output.
const innerShapes = new Map() // servedName -> [{ key, type }]
{
  const probe = Object.fromEntries(rawKeys.map((k) => [k, shapes['object[]']()]))
  const out = deriveAudienceDisplayFields(probe)
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object') {
      innerShapes.set(
        key,
        Object.entries(value[0]).map(([k, v]) => ({
          key: k,
          type: Array.isArray(v) ? 'string[]' : typeof v,
        }))
      )
    }
  }
}

// COMPUTED OUTPUTS, recorded from the actual output rather than by matching a
// probe value. avatar_gender is an enum and personaAvatarUrl is a URL built from
// the seed — neither echoes what was fed in, so neither is captured by the
// shape-matching loop above. Probed WITH the raw fields present, because
// personaAvatarUrl only exists once there is a seed to build it from.
{
  const withFields = Object.fromEntries(rawKeys.map((k) => [k, PROBE_STRING]))
  for (const probe of [withFields, {}]) {
    const out = deriveAudienceDisplayFields(probe)
    for (const [key, value] of Object.entries(out)) {
      if (served.has(key)) continue
      const type =
        key === 'avatar_gender' ? 'string (enum)' : typeof value === 'string' ? 'string (url)' : typeof value
      served.set(key, { type })
    }
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
  personaAvatarUrl: ['Avatar hero', '(computed) avatar_name + avatar_gender, or the coach id'],
  whoTheyAre: ['Avatar hero', 'who_they_are'],
  theirWorld: ['Avatar hero', 'their_world'],
  emotionalState: ['Avatar hero', 'emotional_state'],
  internalDialogue: ['Avatar hero', 'internal_dialogue'],
  triggeringMoment: ['Avatar hero', 'triggering_moment'],
  whyItFailed: ["What they've tried", 'why_it_failed'],
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
  // A COMPUTED key has no raw source to be a camelisation OF, so it cannot be a
  // surprise in this sense and must not swell the list — the guesses-wrong table
  // is specifically about names a reader would derive from a raw key and get
  // wrong. personaAvatarUrl is documented in its own right instead.
  .filter((k) => !SECTIONS[k][1].startsWith('(computed)'))
  .map((k) => ({ servedName: k, rawKey: SECTIONS[k][1].split(' ')[0] }))
  .filter(({ servedName, rawKey }) => camelise(rawKey) !== servedName && servedName !== rawKey)

// ---------------------------------------------------------------------------
// 5. Transform and Monetize. No deriver exists for these tool_types — what the
//    model writes is what is stored and served — so there is no camelCase
//    display set to discover. The trap is different and is spelled out below.
//    Key names read from production saved_outputs via jsonb_object_keys.
// ---------------------------------------------------------------------------
// PATHS, NOT NAMES. Names-only at one level is what left the frontend with no
// shape for selectedProblems[n] and no framework entry at all — the gap this
// depth pass closes.
//
// Every path is PATH-QUALIFIED for a reason: beforeState and afterState exist at
// TWO levels with TWO different types — plain strings at the top of
// transformation_analysis, objects with beliefs/internalTalk/results inside a
// selected problem. Listing the bare name twice would read as a duplicate rather
// than as a collision, so the path is the name here.
//
// Read from production via jsonb_object_keys + jsonb_typeof — names and types
// only, never values.
const TOOL_SHAPES = {
  transformation: [
    ['before_state / after_state', 'string', ''],
    ['before_results / after_results', 'string', ''],
    ['before_internal_talk / after_internal_talk', 'string', ''],
    ['client_language_before / client_language_after', 'string', ''],
    ['the_bridge', 'string', ''],
    ['proof_point', 'string', ''],
    ['completed', 'boolean', 'bookkeeping'],
    ['session_history', 'array', 'bookkeeping — stripped on read'],
  ],
  transformation_analysis: [
    ['zoneOfImpact', 'string', ''],
    ['beforeState', 'string', 'TOP-LEVEL — a plain string. NOT the object of the same name below.'],
    ['afterState', 'string', 'TOP-LEVEL — a plain string. NOT the object of the same name below.'],
    ['intersection[n]', 'string', ''],
    ['uniquelyEquipped[n]', 'string', ''],
    ['selectedProblems[n].id', 'string', ''],
    ['selectedProblems[n].problem', 'string', ''],
    ['selectedProblems[n].outcome', 'string', ''],
    ['selectedProblems[n].whySelected', 'string', ''],
    ['selectedProblems[n].beforeState', 'object', 'NESTED — an OBJECT, unlike the top-level string of the same name'],
    ['selectedProblems[n].beforeState.beliefs / .internalTalk / .results', 'string', ''],
    ['selectedProblems[n].afterState', 'object', 'NESTED — an OBJECT, unlike the top-level string of the same name'],
    ['selectedProblems[n].afterState.beliefs / .internalTalk / .results', 'string', ''],
    ['selectedProblems[n].rootCause', 'object', ''],
    ['selectedProblems[n].rootCause.corePattern / .emotionalProtection / .skillVsIdentity / .sustainingBelief', 'string', ''],
    ['selectedProblems[n].rootDesire', 'object', ''],
    ['selectedProblems[n].rootDesire.emotionalDesire / .identityShift / .lifestyleShift / .surfaceDesire', 'string', ''],
    ['selectedProblems[n].costOfInaction', 'object', ''],
    ['selectedProblems[n].costOfInaction.action / .inaction', 'string', ''],
    ['selectedProblems[n].objectionReframe', 'object', ''],
    ['selectedProblems[n].objectionReframe.objection / .reframe', 'string', ''],
    ['selectedProblems[n].marketingTranslation', 'object', ''],
    ['selectedProblems[n].marketingTranslation.startSaying / .stopSaying', 'string', ''],
    ['confirmed / selected_id / sync_snapshot', 'mixed', 'bookkeeping'],
  ],
  framework: [
    ['frameworkName', 'string', ''],
    ['frameworkTagline', 'string', ''],
    ['descriptiveCopy', 'string', ''],
    ['audienceLanguage', 'string', ''],
    ['useCases[n]', 'string', ''],
    ['name_options[n].id / .name / .tagline / .rationale', 'string', 'snake_case key, camelCase children'],
    ['selected_name_id', 'string', 'points at a name_options[n].id'],
    ['phases[n].id / .name / .tagline / .color', 'string', ''],
    ['phases[n].steps[n].id / .name / .description / .outcome', 'string', 'DEPTH 3 — steps live inside phases'],
    ['confirmed / sync_snapshot', 'mixed', 'bookkeeping'],
  ],
  matcher_intake: [
    ['has_existing_offer', 'boolean', ''],
    ['format / delivery / price', 'string', ''],
    ['completed / session_history', 'mixed', 'bookkeeping'],
  ],
  matcher_analysis: [
    ['top_10[n]', 'object', ''],
    ['recommended_ids[n]', 'string', ''],
    ['why_recommended', 'string', ''],
    ['suggested_offers', 'object', ''],
    ['insights', 'mixed', ''],
    ['selected_ids', 'array', 'bookkeeping'],
  ],
  program: [
    ['program_name / session_type / timeline_reasoning', 'string', ''],
    ['session_length_minutes / total_weeks / total_sessions', 'number', ''],
    ['suggested_starting_price / suggested_capacity_per_month', 'mixed', ''],
    ['weekly_breakdown[n] / deliverables[n]', 'mixed', ''],
    ['confirmed / sync_snapshot', 'mixed', 'bookkeeping'],
  ],
  core_offers: [
    ['low_ticket / mid_ticket / high_ticket', 'object', ''],
    ['next_step_bridge', 'string', ''],
    ['confirmed / sync_snapshot', 'mixed', 'bookkeeping'],
  ],
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
  // An object[] entry needs its INNER keys too, or a renderer has no way to know
  // which value is which and falls back to printing them in key order.
  for (const r of rows) {
    const inner = innerShapes.get(r.name)
    if (!inner) continue
    md += `Each \`${r.name}[n]\` entry:\n\n| inner key | type | notes |\n|---|---|---|\n`
    for (const f of inner) {
      const note =
        f.key === 'monetizationHint'
          ? 'camelCase alias of `monetization_hint` — both are served'
          : f.key === 'monetization_hint'
            ? 'snake_case, as the model emits it'
            : ''
      md += `| \`${f.key}\` | ${f.type} | ${note} |\n`
    }
    md += `\nRead them BY NAME. Rendering \`Object.values(entry)\` prints them in key\norder with no idea which is which — and the hint is served under two spellings,\nso a values-based render shows it twice.\n\n`
  }
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

And a second collision, one level down: **\`beforeState\` and \`afterState\` exist at
TWO DEPTHS in \`transformation_analysis\` with TWO DIFFERENT TYPES.** At the top
they are plain strings; inside \`selectedProblems[n]\` they are objects carrying
\`beliefs\`, \`internalTalk\` and \`results\`. A renderer written for one and handed
the other prints \`[object Object]\` or nothing. Every row below is
PATH-QUALIFIED for that reason — the path is the name, so a collision reads as a
collision rather than as a duplicate line.

Key names below are read from production \`saved_outputs\` via
\`jsonb_object_keys\` — names only, never values.

`
for (const [tool, rows] of Object.entries(TOOL_SHAPES)) {
  md += `### \`${tool}\`\n\n| path | type | notes |\n|---|---|---|\n`
  for (const [pathName, type, note] of rows) md += `| \`${pathName}\` | ${type} | ${note} |\n`
  md += '\n'
}

md += `\`completed\`, \`confirmed\`, \`session_history\`, \`sync_snapshot\`, \`selected_id\`
and \`selected_ids\` are bookkeeping the panel does not render.
`


// ---------------------------------------------------------------------------
// 6. Client Programs — the shapes the three serializers ACTUALLY return.
//
//    Same mechanism as the Attract deriver above: run the real code over a
//    synthetic probe and record what comes out. Nothing here is transcribed
//    from the build brief, so the brief and this document can disagree and the
//    document wins — it is the one derived from the code.
//
//    TWO PROBES, unioned. The "full" probe populates every branch so nested
//    shapes appear; the "minimal" probe is a draft with nothing in it, which is
//    what a programme looks like the moment it is created. A key that is null
//    in either run is marked nullable, so "this can be absent" is a property
//    read from behaviour rather than a guess about intent.
// ---------------------------------------------------------------------------
const {
  serializeProgramSummary,
  serializeProgramDetail,
  serializeClientPortal,
} = programSerializers

const PROGRAM_FULL = {
  id: 'p1',
  user_id: 'u1',
  lead_id: 'l1',
  client_name: 'Probe Client',
  client_email: 'probe@example.invalid',
  client_timezone: 'America/New_York',
  program_name: 'Probe Program',
  total_weeks: 6,
  sessions_allowed: 4,
  start_date: '2026-01-01',
  status: 'active',
  portal_token_version: 1,
  portal_last_opened_at: '2026-01-05T10:00:00Z',
  activated_at: '2026-01-01T09:00:00Z',
  completed_at: null,
}
const ITEMS_FULL = [
  { id: 'i1', kind: 'week', sequence_position: 1, source_week: 1, sort_order: 0, title: 'Week one focus', detail: 'Detail', phase_name: 'Foundations', due_date: null, status: 'pending', completed_at: null, completed_by: null },
  { id: 'i2', kind: 'milestone', sequence_position: 1, source_week: 1, sort_order: 1, title: 'First milestone', detail: null, phase_name: 'Foundations', due_date: '2026-01-07', status: 'completed', completed_at: '2026-01-06T12:00:00Z', completed_by: 'client' },
  // EVERY POSITION HAS A WEEK ROW. There is no milestone-only position — the
  // snapshot mapping inserts a `week` row at each one — so a probe without this
  // row is an illegal shape, and it typed this_week.title/detail/phase_name as
  // `null` for a field that is never null in real data.
  { id: 'i3', kind: 'week', sequence_position: 2, source_week: 2, sort_order: 0, title: 'Week two focus', detail: 'Second detail', phase_name: 'Build', due_date: null, status: 'pending', completed_at: null, completed_by: null },
  { id: 'i4', kind: 'task', sequence_position: 2, source_week: 2, sort_order: 1, title: 'A coach-added task', detail: 'Do the thing', phase_name: 'Build', due_date: '2026-01-14', status: 'pending', completed_at: null, completed_by: null },
]
const REQUESTS_FULL = [
  { id: 'r1', item_id: 'i3', note: 'Any time Thursday', preferred_1: '2026-01-14T14:00:00Z', preferred_2: null, status: 'confirmed', booking_id: 'b1', decline_reason: null, created_at: '2026-01-08T09:00:00Z', resolved_at: '2026-01-08T10:00:00Z', booking: { start_time: '2026-01-14T14:00:00Z', end_time: '2026-01-14T14:30:00Z' } },
  { id: 'r2', item_id: null, note: 'Could we talk this week?', preferred_1: '2026-01-16T15:00:00Z', preferred_2: '2026-01-17T15:00:00Z', status: 'requested', booking_id: null, decline_reason: null, created_at: '2026-01-09T09:00:00Z', resolved_at: null, booking: null },
]
// A client can ask for a call without naming a time or leaving a note, so those
// three are nullable — observed here rather than asserted.
const REQUESTS_BARE = [{ ...REQUESTS_FULL[1], note: null, preferred_1: null, preferred_2: null }]
const NOTES_FULL = [
  { id: 'n1', body: 'Shared note', visibility: 'coach_and_client', created_at: '2026-01-05T10:00:00Z' },
  { id: 'n2', body: 'Private note', visibility: 'coach_only', created_at: '2026-01-05T11:00:00Z' },
]
const BOOKINGS_FULL = [
  { id: 'b1', status: 'active', start_time: '2026-01-14T14:00:00Z', canceled_at: null },
  { id: 'b2', status: 'canceled', start_time: '2026-01-20T14:00:00Z', canceled_at: '2026-01-10T09:00:00Z' },
]
const TODAY = '2026-01-08'

const summaryFull = { program: PROGRAM_FULL, items: ITEMS_FULL, bookings: BOOKINGS_FULL, openSessionRequests: 1, today: TODAY }
// A FINISHED programme, so completed_at has a value to report. Probing only the
// active and draft states would type it `null` and tell a renderer nothing about
// what it holds when it holds something.
const summaryDone = {
  ...summaryFull,
  program: { ...PROGRAM_FULL, status: 'completed', completed_at: '2026-02-12T17:00:00Z' },
}
// Only UNDATED pending work, which is what a coach-added task looks like before
// anyone sets a date. nextPendingItem falls back to these when nothing dated is
// pending, so this is the only state in which next_item.due_date is null — and
// without it the contract would claim that field always has a value.
const summaryUndated = {
  ...summaryFull,
  items: [{ ...ITEMS_FULL[3], id: 'i9', due_date: null }],
}
const summaryMin = {
  program: { ...PROGRAM_FULL, status: 'draft', lead_id: null, client_timezone: null, portal_last_opened_at: null, activated_at: null },
  items: [], bookings: [], openSessionRequests: 0, today: TODAY,
}

const detail = (base, extra) => serializeProgramDetail({ ...base, portalUrl: 'https://example.invalid/p/token', ...extra })
const portal = (base, extra) => serializeClientPortal({ ...base, coachFirstName: 'Dana', ...extra })

const PROGRAM_SHAPES = [
  [
    'GET /api/client-programs',
    '(one array element)',
    [serializeProgramSummary(summaryFull), serializeProgramSummary(summaryDone), serializeProgramSummary(summaryUndated), serializeProgramSummary(summaryMin)],
  ],
  [
    'GET /api/client-programs/[id]',
    'coach detail — notes at BOTH visibilities',
    [
      detail(summaryFull, { notes: NOTES_FULL, sessionRequests: REQUESTS_FULL, discoveryCallCount: 2 }),
      detail(summaryDone, { notes: NOTES_FULL, sessionRequests: REQUESTS_FULL, discoveryCallCount: 2 }),
      detail(summaryUndated, { notes: NOTES_FULL, sessionRequests: REQUESTS_FULL, discoveryCallCount: 2 }),
      detail(summaryMin, { notes: [], sessionRequests: [], discoveryCallCount: 0 }),
    ],
  ],
  [
    'GET /api/client/program?t=',
    'the CLIENT portal — coach_only notes are absent by construction',
    [
      portal(summaryFull, { notes: NOTES_FULL, sessionRequests: REQUESTS_FULL, brand: { '<supplied by lib/brandKit.ts>': true } }),
      portal(summaryFull, { notes: NOTES_FULL, sessionRequests: REQUESTS_BARE, brand: {} }),
      portal(summaryMin, { notes: [], sessionRequests: [], brand: {} }),
    ],
  ],
]

// Walk an output value into path -> type rows. Arrays descend into their first
// element and are reported as `path[]`, so an inner rename is a diff rather than
// a silently unchanged line.
function describe(value, prefix, out) {
  if (Array.isArray(value)) {
    out.set(prefix, 'array')
    // EVERY element, not just [0]. The first item in `items` is a `week` row
    // with no completion and no due date, so describing only that one types
    // completed_at, completed_by and due_date as `null` and tells a renderer
    // nothing about what they carry when they carry something.
    for (const el of value) {
      if (!el || typeof el !== 'object' || Array.isArray(el)) continue
      for (const [k, v] of Object.entries(el)) {
        const key = `${prefix}[].${k}`
        const prior = out.get(key)
        const before = new Map()
        describe(v, key, before)
        for (const [pk, pv] of before) {
          // A concrete type beats a null seen on another element.
          if (out.get(pk) === undefined || out.get(pk) === 'null') out.set(pk, pv)
          else if (pv === 'null') out.set(`${pk}\u0000null`, 'null')
        }
        if (prior === 'null' && out.get(key) !== 'null') out.set(`${key}\u0000null`, 'null')
      }
    }
    return
  }
  if (value && typeof value === 'object') {
    out.set(prefix, 'object')
    for (const [k, v] of Object.entries(value)) describe(v, `${prefix}.${k}`, out)
    return
  }
  out.set(prefix, value === null ? 'null' : typeof value)
}

md += `
---

## Client Programs — generated from the serializers

Emitted by running \`lib/clientProgramSerializers.ts\` over a synthetic probe, the
same way the Attract table above runs the real deriver. **The code is the
contract**; if the build brief and this table disagree, this table is the one
derived from what ships.

Two probes are unioned: a populated programme, and a \`draft\` with nothing in it.
A key marked **nullable** came back \`null\` in one of them — that is behaviour,
not intent.

No customer data. Every value is a synthetic probe.

`
for (const [route, note, runs] of PROGRAM_SHAPES) {
  const maps = runs.map((r) => { const m = new Map(); describe(r, '', m); return m })

  md += `### \`${route}\`\n\n${note}\n\n| path | type | nullable |\n|---|---|---|\n`
  const paths = [...new Set(maps.flatMap((m) => [...m.keys()]))].filter((k) => k && !k.includes('\u0000')).sort()
  for (const pth of paths) {
    const seen = maps.map((m) => m.get(pth))
    // NULLABLE means a run actually returned null for THIS path. Absent because
    // a parent was null is not the same claim — marking `next_item.id` nullable
    // because `next_item` itself can be null would describe a field that is
    // never null when it exists. The \u0000null sentinel records "some ELEMENT of
    // this array had null here", which a single winning type would otherwise hide.
    const nullable = seen.includes('null') || maps.some((m) => m.has(`${pth}\u0000null`))
    const type = seen.find((t) => t && t !== 'null') || 'null'
    md += `| \`${pth.replace(/^\./, '')}\` | ${type} | ${nullable ? 'yes' : ''} |\n`
  }
  md += '\n'
}

md += `**The portal's omissions are the contract too.** \`user_id\`, \`lead_id\`,
\`program_snapshot\`, \`portal_token_version\`, \`client_email\` and every
\`coach_only\` note are absent from \`GET /api/client/program\` above because the
shape is built key by key — a new column on \`client_programs\` cannot reach the
client by being added upstream.

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
