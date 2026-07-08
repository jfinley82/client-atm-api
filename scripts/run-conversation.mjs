#!/usr/bin/env node
// Scripted conversation runner for the MTM chat tools.
//
// Plays a pre-written sequence of answers against the LIVE deployed API,
// exactly the way the real frontend does (Bearer auth, per-turn POST to
// /api/tools/{tool}, cumulative session_history), so a full tool conversation
// can be exercised end-to-end in under a minute instead of typed by hand.
//
// It is deliberately dependency-free (Node 18+ global fetch). It hits the real
// endpoint — it does NOT mock or bypass anything — so it upserts the test
// user's saved_outputs row just like a real session would.
//
// Usage:
//   CATM_TOKEN=<jwt> node scripts/run-conversation.mjs scripts/conversations/transformation.sample.json
//   node scripts/run-conversation.mjs <spec.json> --token <jwt> --base <url> --tool transformation
//
// See scripts/README.md for the full contract and the spec-file format.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const positional = []
const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { flags[key] = true } // boolean flag
    else { flags[key] = next; i++ }
  } else {
    positional.push(a)
  }
}

const specPath = positional[0]
if (!specPath) {
  console.error('Usage: node scripts/run-conversation.mjs <spec.json> [--token <jwt>] [--base <url>] [--tool <t>] [--max-turns N] [--verbose] [--swap]')
  process.exit(2)
}

const DEFAULT_BASE = 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'
const base = (flags.base || process.env.API_BASE || DEFAULT_BASE).replace(/\/+$/, '')
const token = flags.token || process.env.CATM_TOKEN || ''
const maxTurns = Number(flags['max-turns'] || 30)
const verbose = !!flags.verbose
// --swap: exercise the re-select path at each decision point in the Transform
// pipeline (transformation candidate, framework name) or the Matcher pipeline
// (problem selection) instead of the default pick, so the swap/re-select code
// path itself gets tested too.
const swap = !!flags.swap

if (!token) {
  console.error('ERROR: no auth token. Pass --token <jwt> or set CATM_TOKEN.\n' +
    'This must be a real session JWT for the test account (the same "Bearer" token the browser sends).')
  process.exit(2)
}

// ─── spec ────────────────────────────────────────────────────────────────────
let spec
try {
  spec = JSON.parse(readFileSync(resolve(specPath), 'utf8'))
} catch (e) {
  console.error(`ERROR: could not read/parse spec file "${specPath}": ${e.message}`)
  process.exit(2)
}
const tool = flags.tool || spec.tool
if (!['audience', 'transformation', 'matcher'].includes(tool)) {
  console.error(`ERROR: spec.tool (or --tool) must be audience|transformation|matcher, got: ${tool}`)
  process.exit(2)
}
const answers = Array.isArray(spec.answers) ? spec.answers : []
if (answers.length === 0) {
  console.error('ERROR: spec.answers must be a non-empty array of strings.')
  process.exit(2)
}
const fillerAnswer = spec.fillerAnswer ||
  "That's everything I can think of — please put together the final output based on what we've covered."
const expectedFields = Array.isArray(spec.expectedFields) ? spec.expectedFields : null

// Schema field names, for narration-leak scanning of the visible message text.
const SCHEMA_FIELDS = [
  'who_they_are', 'their_world', 'emotional_state', 'internal_dialogue', 'perceived_problem',
  'real_problem', 'tried_before', 'why_it_failed', 'language_they_use', 'triggering_moment',
  'dream_outcome', 'buying_triggers', 'motivating_phrases', 'repelling_phrases', 'where_to_find_them',
  'sales_objections', 'pain_points', 'fears_and_doubts', 'gap_insight', 'language_problem',
  'language_solution', 'other_angles', 'connection_summary', 'monetize_bridge', 'avatar_name',
  'problem_statement', 'before_state', 'after_state', 'the_bridge', 'proof_point',
  'before_internal_talk', 'after_internal_talk', 'before_results', 'after_results',
  'client_language_before', 'client_language_after', 'has_existing_offer',
]

// ─── helpers ─────────────────────────────────────────────────────────────────
const trunc = (s, n = 220) => {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) + '…' : str
}
const isEmptyVal = (v) =>
  v == null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0)

function diffStructured(prev, curr) {
  if (curr == null) return { status: 'null', added: [], changed: [] }
  if (prev == null) return { status: 'first', added: Object.keys(curr), changed: [] }
  const added = [], changed = []
  for (const k of Object.keys(curr)) {
    if (!(k in prev)) added.push(k)
    else if (JSON.stringify(prev[k]) !== JSON.stringify(curr[k])) changed.push(k)
  }
  const status = added.length || changed.length ? 'changed' : 'unchanged'
  return { status, added, changed }
}

// narration leak: schema field name appearing as literal text, or a raw <data>
// tag / JSON-object dump in the visible message.
function scanLeak(message) {
  const hits = []
  if (/<\/?data>/i.test(message)) hits.push('<data> tag')
  if (/"\w+"\s*:/.test(message)) hits.push('JSON-object fragment')
  for (const f of SCHEMA_FIELDS) {
    if (message.includes(f)) hits.push(f)
  }
  return hits
}

// repeated-content checks on array-of-string fields.
function scanArrayAnomalies(data) {
  const issues = []
  if (!data || typeof data !== 'object') return issues
  for (const [k, v] of Object.entries(data)) {
    if (!Array.isArray(v) || v.length < 2) continue
    const strs = v.filter((x) => typeof x === 'string')
    if (strs.length < 2) continue
    // exact duplicates
    const seen = new Set(), dups = new Set()
    for (const s of strs) { if (seen.has(s)) dups.add(s); seen.add(s) }
    if (dups.size) issues.push(`${k}: ${dups.size} exact-duplicate entr${dups.size === 1 ? 'y' : 'ies'}`)
    // shared trailing clause (the old objections-templating bug signature)
    const suffixes = strs.map((s) => (s.includes(' — ') ? s.slice(s.indexOf(' — ')) : null)).filter(Boolean)
    if (suffixes.length >= 2) {
      const suffCount = new Map()
      for (const suf of suffixes) suffCount.set(suf, (suffCount.get(suf) || 0) + 1)
      for (const [suf, n] of suffCount) {
        if (n >= 2) issues.push(`${k}: ${n} entries share the SAME trailing clause "${trunc(suf, 60)}"`)
      }
    }
  }
  return issues
}

// Recursively collects "path: value" for every empty leaf (empty string or
// empty array) under an object — used to spot-check the deep nested fields in
// transformation candidates / framework phases that the top-level anomaly
// scan (which only looks at direct fields) never reaches. Skips `id`/`color`
// keys, which are structural, not content.
function deepEmptyFields(obj, prefix = '') {
  const out = []
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id' || k === 'color') continue
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...deepEmptyFields(v, path))
    else if (isEmptyVal(v)) out.push(path)
  }
  return out
}

// Flags exact-duplicate text across a set of items that are supposed to be 3
// genuinely distinct angles on the same thing (candidates' problem framing,
// framework name options, framework phases) — the same "distinctness" bar the
// backend prompts themselves require.
function checkDistinctText(items, getText, label) {
  const texts = items.map(getText)
  const seen = new Set(), dups = new Set()
  for (const t of texts) { if (seen.has(t)) dups.add(t); seen.add(t) }
  return dups.size ? [`${label}: ${dups.size} of ${items.length} entries are textually identical`] : []
}

// POST helper for the one-shot Transform pipeline endpoints (analyze/select/
// confirm). Any HTTP failure is treated as a stage failure — same discipline
// as the per-turn conversation loop: print exactly which stage broke, then
// exit(1) immediately rather than continuing into a stage whose precondition
// just failed.
async function postJson(path, body, stageLabel) {
  const fullUrl = `${base}${path}`
  let res
  try {
    res = await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
    })
  } catch (e) {
    console.error(`\n✖ STAGE FAILED: ${stageLabel}\n  POST ${path}\n  network error: ${e.message}`)
    process.exit(1)
  }
  const text = await res.text()
  if (!res.ok) {
    let hint = ''
    if (res.status === 401) hint = ' (401 → auth token issue)'
    if (res.status === 403) hint = ' (403 → test account likely lacks a paid membership_tier: low_ticket/full)'
    if (res.status === 400) hint = ' (400 → a precondition for this stage was not met — see body below)'
    console.error(`\n✖ STAGE FAILED: ${stageLabel}\n  POST ${path}\n  HTTP ${res.status} ${res.statusText}${hint}\n  ${trunc(text, 500)}`)
    process.exit(1)
  }
  try {
    return JSON.parse(text)
  } catch {
    console.error(`\n✖ STAGE FAILED: ${stageLabel}\n  POST ${path}\n  non-JSON response:\n  ${trunc(text, 500)}`)
    process.exit(1)
  }
}

// Structural "expected state" assertion — the counts/shape the user asked to
// be treated as hard failures, not soft anomalies (unlike content-quality
// issues like empty nested fields or duplicate text, which are collected as
// warnings instead). Exits immediately with the exact stage name on violation.
function assertStage(condition, stageLabel, detail) {
  if (condition) return
  console.error(`\n✖ STAGE FAILED: ${stageLabel}\n  ${detail}`)
  process.exit(1)
}

// ─── run ─────────────────────────────────────────────────────────────────────
const url = `${base}/api/tools/${tool}`
console.log('━'.repeat(70))
console.log(`Conversation runner  ·  tool=${tool}`)
console.log(`POST ${url}`)
console.log(`answers: ${answers.length} scripted  ·  max turns: ${maxTurns}`)

// ── Auth preflight diagnostic ──
// The server accepts a Bearer token alone (no cookie required — see
// lib/auth.ts getSessionFromRequest, which returns the header token before ever
// looking at cookies). So a 401 with a token that works in the browser almost
// always means the token STRING sent here differs from the browser's — most
// often stray whitespace/newline captured into CATM_TOKEN (e.g. `export
// CATM_TOKEN=$(cat file)` keeps the trailing newline). This surfaces the exact
// header shape so that's visible before the request fires. Token is masked.
{
  const rawLen = token.length
  const trimmed = token.trim()
  const edgeWs = rawLen - trimmed.length
  const innerWs = /\s/.test(trimmed)
  const jwtShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)
  const mask = (t) => (t.length <= 20 ? '<suspiciously short>' : `${t.slice(0, 12)}…${t.slice(-6)}`)
  console.log('auth preflight:')
  console.log(`  header sent : "Authorization: Bearer ${mask(token)}"`)
  console.log(`  token length: ${rawLen}`)
  console.log(`  leading/trailing whitespace: ${edgeWs ? `YES ⚠  (${edgeWs} char(s) — this is very likely the 401 cause)` : 'none'}`)
  console.log(`  inner whitespace/newline    : ${innerWs ? 'YES ⚠  (token is mangled — not a clean JWT)' : 'none'}`)
  console.log(`  JWT shape (3 base64url parts): ${jwtShape ? 'ok' : 'NO ⚠  (does not look like a header.payload.signature JWT)'}`)
}
console.log('━'.repeat(70))

const sessionHistory = []   // [{role, content}, ...] cumulative, exactly like the frontend
let prevStructured = null
let finalStructured = null
let sawDataThisRun = false  // did THIS run produce its own <data>? (see stop condition)
let completedReached = false
let turnsTaken = 0
let answersExhausted = false
const leaks = []            // {turn, hits}
const t0 = Date.now()

for (let turn = 1; turn <= maxTurns; turn++) {
  const scripted = turn <= answers.length
  if (!scripted) answersExhausted = true
  const answer = scripted ? answers[turn - 1] : fillerAnswer
  const currentStep = turn   // realistic incrementing step; server completion is hasTerminalFields-driven regardless

  const body = { message: answer, session_history: sessionHistory, current_step: currentStep }

  const tTurn = Date.now()
  let res, json
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.error(`\n✖ turn ${turn}: network error hitting ${url}: ${e.message}`)
    process.exit(1)
  }
  const ms = Date.now() - tTurn
  const text = await res.text()
  if (!res.ok) {
    console.error(`\n✖ turn ${turn}: HTTP ${res.status} ${res.statusText}\n${trunc(text, 500)}`)
    if (res.status === 401) console.error('  (401 → the token is missing/expired/invalid)')
    process.exit(1)
  }
  try { json = JSON.parse(text) } catch { console.error(`\n✖ turn ${turn}: non-JSON response:\n${trunc(text, 500)}`); process.exit(1) }

  turnsTaken = turn
  const { message = '', options = null, structured_data = null, step_complete, completed } = json
  const diff = diffStructured(prevStructured, structured_data)
  if (structured_data != null) { prevStructured = structured_data; finalStructured = structured_data; sawDataThisRun = true }

  // narration-leak scan on the visible message
  const hits = scanLeak(String(message))
  if (hits.length) leaks.push({ turn, hits })

  // ── per-turn print ──
  console.log(`\n── turn ${turn} ${scripted ? '' : '(filler — scripted answers exhausted)'} · ${ms}ms ─────────────────`)
  console.log(`  ► sent: ${trunc(answer, 160)}`)
  console.log(`  ◄ AI  : ${trunc(message, 400)}`)
  if (Array.isArray(options) && options.length) console.log(`  options: ${JSON.stringify(options)}`)
  let sdLine
  if (diff.status === 'null') sdLine = 'null (no <data> this turn)'
  else if (diff.status === 'unchanged') sdLine = 'unchanged'
  else if (diff.status === 'first') sdLine = `first snapshot — ${diff.added.length} fields (${diff.added.join(', ')})`
  else sdLine = `${diff.added.length ? '+[' + diff.added.join(', ') + '] ' : ''}${diff.changed.length ? '~[' + diff.changed.join(', ') + ']' : ''}`.trim()
  console.log(`  structured_data: ${sdLine}`)
  console.log(`  step_complete=${step_complete}   COMPLETED=${completed === true ? 'TRUE ✅' : completed}`)
  if (hits.length) console.log(`  ⚠ possible narration leak in message: ${hits.join(', ')}`)
  if (verbose && structured_data) console.log('  full structured_data:\n' + JSON.stringify(structured_data, null, 2).split('\n').map((l) => '    ' + l).join('\n'))

  // update history exactly like the frontend (append user + assistant)
  sessionHistory.push({ role: 'user', content: answer })
  sessionHistory.push({ role: 'assistant', content: message })

  // Stop only on a REAL completion of THIS run: completed:true accompanied by
  // structured_data produced during this run. A completed:true with no data yet
  // is the server carrying a PRIOR completed session's flag forward (monotonic
  // completion — see api/tools/chat.ts), i.e. inherited, not earned here — so we
  // keep going until this conversation generates its own <data>/terminal fields.
  if (completed === true && sawDataThisRun) { completedReached = true; break }
  if (completed === true && !sawDataThisRun) {
    console.log('  (note: completed:true but no structured_data yet — inherited from a prior completed session for this user; continuing)')
  }
  if (completed === undefined && step_complete === true && sawDataThisRun) {
    // Fallback for a deploy that predates the `completed` field.
    console.log('  (note: response had no `completed` field; stopping on legacy step_complete)')
    completedReached = true; break
  }
}

const totalMs = Date.now() - t0

// ─── summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '━'.repeat(70))
console.log('SUMMARY')
console.log('━'.repeat(70))
console.log(`Turns taken       : ${turnsTaken}`)
console.log(`Wall clock        : ${(totalMs / 1000).toFixed(1)}s`)
console.log(`Completed reached : ${completedReached ? 'YES ✅' : 'NO ❌ (never returned completed:true within max turns)'}`)
if (answersExhausted) console.log(`⚠ Scripted answers ran out before completion — filler answers were used to continue.`)

// expected-field coverage
if (expectedFields) {
  const present = [], missing = []
  for (const f of expectedFields) {
    const v = finalStructured ? finalStructured[f] : undefined
    if (isEmptyVal(v)) missing.push(f); else present.push(f)
  }
  console.log(`\nExpected fields   : ${present.length}/${expectedFields.length} populated`)
  if (missing.length) console.log(`  ❌ missing/empty: ${missing.join(', ')}`)
  else console.log(`  ✅ all expected fields populated`)
} else {
  console.log('\nExpected fields   : (none declared in spec — skipping coverage check)')
}

// anomalies
const emptyFields = finalStructured
  ? Object.entries(finalStructured).filter(([, v]) => isEmptyVal(v)).map(([k]) => k)
  : []
const arrayIssues = scanArrayAnomalies(finalStructured)

console.log('\nAnomaly scan:')
if (emptyFields.length) console.log(`  ⚠ empty fields present: ${emptyFields.join(', ')}`)
else console.log('  ✓ no empty fields in final structured_data')
if (arrayIssues.length) arrayIssues.forEach((i) => console.log(`  ⚠ repeated content — ${i}`))
else console.log('  ✓ no duplicate / templated-looking array entries')
if (leaks.length) leaks.forEach((l) => console.log(`  ⚠ narration leak on turn ${l.turn}: ${l.hits.join(', ')}`))
else console.log('  ✓ no narration leaks in any visible message')

// final structured_data
console.log('\nFinal structured_data:')
console.log(finalStructured ? JSON.stringify(finalStructured, null, 2) : '  (none captured)')

// ─── Transform pipeline (analyze → select → confirm, both Part A and Part B) ──
// Only applies to the transformation tool, and only once the conversation
// itself genuinely completed — the pipeline's own preconditions require a
// completed transformation session (and a completed audience session, for the
// framework stage).
const pipelineIssues = []   // soft content-quality anomalies — reported, flips VERDICT, doesn't abort
let pipelineRan = false

if (tool === 'transformation' && completedReached) {
  pipelineRan = true
  console.log('\n' + '━'.repeat(70))
  console.log(`TRANSFORM PIPELINE${swap ? '  (--swap: exercising the re-select path at each decision point)' : ''}`)
  console.log('━'.repeat(70))

  // ── Stage 1: transformation/analyze ──
  console.log('\n[1/6] POST /api/tools/transformation/analyze')
  const analysis = await postJson('/api/tools/transformation/analyze', {}, 'transformation/analyze')
  assertStage(
    Array.isArray(analysis.selectedProblems) && analysis.selectedProblems.length === 3,
    'transformation/analyze',
    `expected exactly 3 candidates, got ${Array.isArray(analysis.selectedProblems) ? analysis.selectedProblems.length : typeof analysis.selectedProblems}`
  )
  console.log(`  zoneOfImpact     : ${trunc(analysis.zoneOfImpact, 200)}`)
  console.log(`  intersection     : ${JSON.stringify(analysis.intersection)}`)
  console.log(`  uniquelyEquipped : ${JSON.stringify(analysis.uniquelyEquipped)}`)
  for (const c of analysis.selectedProblems) {
    console.log(`  candidate ${c.id}: problem: ${trunc(c.problem, 140)}`)
    console.log(`             whySelected: ${trunc(c.whySelected, 140)}`)
  }
  pipelineIssues.push(...checkDistinctText(analysis.selectedProblems, (c) => c.problem, 'candidates[].problem'))
  for (const c of analysis.selectedProblems) {
    const empties = deepEmptyFields(c)
    if (empties.length) pipelineIssues.push(`candidate ${c.id}: empty field(s) — ${empties.join(', ')}`)
  }

  // ── Stage 2: transformation/select ──
  // No model-suggested default exists here (unlike framework) — selected_id is
  // always null coming out of /analyze, so /select is required every run, not
  // only for --swap. Default picks the first candidate (t1); --swap re-selects
  // a second, different candidate afterward to also exercise the re-select
  // path (confirmed resets to false on re-selection).
  console.log('\n[2/6] POST /api/tools/transformation/select')
  const firstPick = analysis.selectedProblems[0]
  console.log(`  picking ${firstPick.id} (default — transformation/analyze has no model-suggested selected_id to accept as-is)`)
  let selectResult = await postJson('/api/tools/transformation/select', { selected_id: firstPick.id }, 'transformation/select')
  assertStage(selectResult.selected_id === firstPick.id, 'transformation/select', `selected_id did not stick: expected ${firstPick.id}, got ${selectResult.selected_id}`)
  if (swap) {
    const swapTarget = analysis.selectedProblems.find((c) => c.id !== firstPick.id)
    console.log(`  --swap: re-selecting ${swapTarget.id} to exercise the re-select path`)
    selectResult = await postJson('/api/tools/transformation/select', { selected_id: swapTarget.id }, 'transformation/select (swap)')
    assertStage(selectResult.selected_id === swapTarget.id, 'transformation/select (swap)', `selected_id did not swap: expected ${swapTarget.id}, got ${selectResult.selected_id}`)
    assertStage(selectResult.confirmed === false, 'transformation/select (swap)', 'expected confirmed:false to reset on re-selection')
  }
  console.log(`  selected_id=${selectResult.selected_id}  confirmed=${selectResult.confirmed}`)

  // ── Stage 3: transformation/confirm ──
  console.log('\n[3/6] POST /api/tools/transformation/confirm')
  const chosenCandidate = selectResult.selectedProblems.find((c) => c.id === selectResult.selected_id)
  const confirmedAnalysis = await postJson('/api/tools/transformation/confirm', {
    zoneOfImpact: selectResult.zoneOfImpact,
    intersection: selectResult.intersection,
    uniquelyEquipped: selectResult.uniquelyEquipped,
    candidate: chosenCandidate,
  }, 'transformation/confirm')
  assertStage(confirmedAnalysis.confirmed === true, 'transformation/confirm', `expected confirmed:true, got ${confirmedAnalysis.confirmed}`)
  assertStage(confirmedAnalysis.selected_id === chosenCandidate.id, 'transformation/confirm', 'selected_id changed unexpectedly on confirm')
  console.log(`  confirmed candidate: ${confirmedAnalysis.selected_id}  confirmed=${confirmedAnalysis.confirmed}`)

  // ── Stage 4: transformation/framework/analyze ──
  console.log('\n[4/6] POST /api/tools/transformation/framework/analyze')
  const framework = await postJson('/api/tools/transformation/framework/analyze', {}, 'transformation/framework/analyze')
  assertStage(
    Array.isArray(framework.name_options) && framework.name_options.length === 3,
    'transformation/framework/analyze',
    `expected exactly 3 name_options, got ${Array.isArray(framework.name_options) ? framework.name_options.length : typeof framework.name_options}`
  )
  assertStage(
    Array.isArray(framework.phases) && framework.phases.length === 3,
    'transformation/framework/analyze',
    `expected exactly 3 phases, got ${Array.isArray(framework.phases) ? framework.phases.length : typeof framework.phases}`
  )
  for (const p of framework.phases) {
    assertStage(
      Array.isArray(p.steps) && p.steps.length >= 2 && p.steps.length <= 3,
      'transformation/framework/analyze',
      `phase ${p.id} (${p.name}) has ${Array.isArray(p.steps) ? p.steps.length : typeof p.steps} steps, expected 2-3`
    )
  }
  console.log(`  name_options: ${framework.name_options.map((o) => `${o.id}="${trunc(o.name, 60)}"`).join('  |  ')}`)
  console.log(`  model's own pick (selected_name_id): ${framework.selected_name_id}`)
  for (const p of framework.phases) console.log(`  phase ${p.id}: ${trunc(p.name, 60)}  (${p.steps.length} steps)`)
  pipelineIssues.push(...checkDistinctText(framework.name_options, (o) => o.name, 'name_options[].name'))
  pipelineIssues.push(...checkDistinctText(framework.phases, (p) => p.name, 'phases[].name'))
  for (const o of framework.name_options) {
    const empties = deepEmptyFields(o)
    if (empties.length) pipelineIssues.push(`name_option ${o.id}: empty field(s) — ${empties.join(', ')}`)
  }
  for (const p of framework.phases) {
    const empties = deepEmptyFields(p)
    if (empties.length) pipelineIssues.push(`phase ${p.id}: empty field(s) — ${empties.join(', ')}`)
    for (const s of p.steps) {
      const stepEmpties = deepEmptyFields(s)
      if (stepEmpties.length) pipelineIssues.push(`phase ${p.id} step ${s.id}: empty field(s) — ${stepEmpties.join(', ')}`)
    }
  }

  // ── Stage 5: transformation/framework/select (only with --swap) ──
  // framework/analyze DOES carry a real model-suggested default (selected_name_id,
  // already resolved into frameworkName/frameworkTagline) — unlike transformation's
  // candidates, so the default path genuinely accepts it as-is and skips /select.
  let chosenFramework = framework
  console.log('\n[5/6] POST /api/tools/transformation/framework/select')
  if (swap) {
    const swapTarget = framework.name_options.find((o) => o.id !== framework.selected_name_id)
    console.log(`  --swap: selecting ${swapTarget.id} instead of the model's own pick (${framework.selected_name_id})`)
    chosenFramework = await postJson('/api/tools/transformation/framework/select', { selected_name_id: swapTarget.id }, 'transformation/framework/select')
    assertStage(chosenFramework.selected_name_id === swapTarget.id, 'transformation/framework/select', `selected_name_id did not swap: expected ${swapTarget.id}, got ${chosenFramework.selected_name_id}`)
    console.log(`  frameworkName now: ${trunc(chosenFramework.frameworkName, 80)}`)
  } else {
    console.log(`  skipped — accepting the model's own selected_name_id (${framework.selected_name_id}) as-is`)
  }

  // ── Stage 6: transformation/framework/confirm ──
  console.log('\n[6/6] POST /api/tools/transformation/framework/confirm')
  const confirmedFramework = await postJson('/api/tools/transformation/framework/confirm', {
    frameworkName: chosenFramework.frameworkName,
    frameworkTagline: chosenFramework.frameworkTagline,
    phases: chosenFramework.phases,
    descriptiveCopy: chosenFramework.descriptiveCopy,
    useCases: chosenFramework.useCases,
    audienceLanguage: chosenFramework.audienceLanguage,
  }, 'transformation/framework/confirm')
  assertStage(confirmedFramework.confirmed === true, 'transformation/framework/confirm', `expected confirmed:true, got ${confirmedFramework.confirmed}`)
  const finalFrameworkFields = ['frameworkName', 'frameworkTagline', 'descriptiveCopy', 'useCases', 'audienceLanguage']
  const missingFrameworkFields = finalFrameworkFields.filter((f) => isEmptyVal(confirmedFramework[f]))
  assertStage(
    missingFrameworkFields.length === 0,
    'transformation/framework/confirm',
    `required field(s) empty after confirm: ${missingFrameworkFields.join(', ')}`
  )
  console.log(`  confirmed=${confirmedFramework.confirmed}`)
  console.log(`  frameworkName    : ${confirmedFramework.frameworkName}`)
  console.log(`  frameworkTagline : ${confirmedFramework.frameworkTagline}`)
  console.log(`  descriptiveCopy  : ${trunc(confirmedFramework.descriptiveCopy, 160)}`)
  console.log(`  useCases         : ${JSON.stringify(confirmedFramework.useCases)}`)
  console.log(`  audienceLanguage : ${trunc(confirmedFramework.audienceLanguage, 160)}`)

  // ── Pipeline summary ──
  console.log('\n' + '━'.repeat(70))
  console.log('TRANSFORM PIPELINE SUMMARY')
  console.log('━'.repeat(70))
  console.log('Stage results     : all 6 stages reached their expected state ✅')
  console.log(`Candidates        : exactly 3 (${analysis.selectedProblems.map((c) => c.id).join(', ')}) ✅`)
  console.log(`Phases            : exactly 3, each with 2-3 steps (${framework.phases.map((p) => p.steps.length).join(', ')}) ✅`)
  console.log(`Framework fields  : frameworkName/frameworkTagline/descriptiveCopy/useCases/audienceLanguage all populated ✅`)
  console.log('\nAnomaly scan (Transform pipeline):')
  console.log('  (narration-leak scan not applicable — no conversational message channel in this pipeline, only direct JSON responses)')
  if (pipelineIssues.length) pipelineIssues.forEach((i) => console.log(`  ⚠ ${i}`))
  else console.log('  ✓ no empty nested fields, no duplicate/templated candidate, name, or phase text')
}

// ─── Matcher pipeline (analyze → selection → finalize) ──────────────────────
// Only applies to the matcher tool, and only once the intake conversation
// itself genuinely completed. Contracts verified against source (api/matcher/
// {analyze,selection,finalize}.ts), not assumed:
// - matcher/analyze requires audience + transformation + matcher_intake to all
//   be COMPLETE already (isContentComplete), not just present — a run against
//   a fresh test user with only the matcher intake done will 400 here with
//   audience_incomplete/transformation_incomplete. That's a real precondition,
//   not a runner bug.
// - matcher/analyze ALSO sets selected_ids = recommended_ids server-side
//   before saving (see api/matcher/analyze.ts) and generates suggested_offers
//   for those 3 ids in the same call — so, like framework/select (and unlike
//   transformation/select, where selected_id is always null out of /analyze),
//   /selection is NOT required to accept the model's own picks. The default
//   run skips it; --swap calls it with a genuinely different combination of 3
//   ids drawn from the remaining 7.
// - matcher/finalize's body is the bare array of 3 cards, not wrapped in an
//   object (unlike every other pipeline endpoint in this app).
// - card_name is not produced anywhere in the generation pipeline (Top10Problem
//   only has id/problem/reasoning; SuggestedOffer.name is null whenever the
//   coach already has an existing offer — which matcher.sample.json's intake
//   does). Vibe presumably lets the member type/edit this. Since the ask here
//   is to submit "generated content unedited," the runner synthesizes a
//   card_name from the problem text so the required, non-empty field is
//   satisfied — that's a test-only stand-in, not a value the backend ever
//   generates itself. Flagged here rather than silently assumed.
if (tool === 'matcher' && completedReached) {
  pipelineRan = true
  console.log('\n' + '━'.repeat(70))
  console.log(`MATCHER PIPELINE${swap ? '  (--swap: exercising the re-select path with a different combination of 3)' : ''}`)
  console.log('━'.repeat(70))

  // ── Stage 1: matcher/analyze ──
  console.log('\n[1/3] POST /api/matcher/analyze')
  const analysis = await postJson('/api/matcher/analyze', {}, 'matcher/analyze')
  assertStage(
    Array.isArray(analysis.top_10) && analysis.top_10.length === 10,
    'matcher/analyze',
    `expected exactly 10 top_10 entries, got ${Array.isArray(analysis.top_10) ? analysis.top_10.length : typeof analysis.top_10}`
  )
  assertStage(
    Array.isArray(analysis.recommended_ids) && analysis.recommended_ids.length === 3,
    'matcher/analyze',
    `expected exactly 3 recommended_ids, got ${Array.isArray(analysis.recommended_ids) ? analysis.recommended_ids.length : typeof analysis.recommended_ids}`
  )
  console.log(`  why_recommended: ${trunc(analysis.why_recommended, 200)}`)
  console.log(`  insights       : ${trunc(analysis.insights, 200)}`)
  console.log(`  recommended_ids: ${JSON.stringify(analysis.recommended_ids)}`)
  console.log('  top_10:')
  for (const p of analysis.top_10) {
    console.log(`    ${p.id}${analysis.recommended_ids.includes(p.id) ? ' ★' : '  '}: ${trunc(p.problem, 140)}`)
    console.log(`      reasoning: ${trunc(p.reasoning, 140)}`)
  }
  pipelineIssues.push(...checkDistinctText(analysis.top_10, (p) => p.problem, 'top_10[].problem'))
  for (const p of analysis.top_10) {
    const empties = deepEmptyFields(p)
    if (empties.length) pipelineIssues.push(`top_10 ${p.id}: empty field(s) — ${empties.join(', ')}`)
  }

  // ── Stage 2: matcher/selection ──
  let selected = analysis
  console.log('\n[2/3] POST /api/matcher/selection')
  if (swap) {
    const swapIds = analysis.top_10.filter((p) => !analysis.recommended_ids.includes(p.id)).slice(0, 3).map((p) => p.id)
    assertStage(swapIds.length === 3, 'matcher/selection (swap)', `expected 3 non-recommended ids to swap in, found ${swapIds.length}`)
    console.log(`  --swap: selecting ${JSON.stringify(swapIds)} instead of the model's own recommended_ids (${JSON.stringify(analysis.recommended_ids)})`)
    selected = await postJson('/api/matcher/selection', { selected_ids: swapIds }, 'matcher/selection')
    assertStage(
      Array.isArray(selected.selected_ids) && selected.selected_ids.length === 3 && swapIds.every((id) => selected.selected_ids.includes(id)),
      'matcher/selection',
      `selected_ids did not swap: expected ${JSON.stringify(swapIds)}, got ${JSON.stringify(selected.selected_ids)}`
    )
    for (const id of swapIds) {
      assertStage(!!selected.suggested_offers[id], 'matcher/selection', `no suggested_offer generated for newly-selected id ${id}`)
    }
    console.log(`  selected_ids now: ${JSON.stringify(selected.selected_ids)}`)
  } else {
    console.log(`  skipped — matcher/analyze already set selected_ids to the model's own recommended_ids (${JSON.stringify(analysis.selected_ids)}) with suggested_offers generated`)
  }

  // ── Stage 3: matcher/finalize ──
  console.log('\n[3/3] POST /api/matcher/finalize')
  const finalIds = selected.selected_ids
  const byId = new Map(analysis.top_10.map((p) => [p.id, p]))
  const cards = finalIds.map((id) => {
    const p = byId.get(id)
    return {
      id,
      card_name: trunc(p.problem, 60),
      problem_text: p.problem,
      reasoning: p.reasoning,
      suggested_offer: selected.suggested_offers[id],
    }
  })
  const finalized = await postJson('/api/matcher/finalize', cards, 'matcher/finalize')
  assertStage(
    Array.isArray(finalized) && finalized.length === 3,
    'matcher/finalize',
    `expected exactly 3 cards created, got ${Array.isArray(finalized) ? finalized.length : typeof finalized}`
  )
  for (const row of finalized) {
    assertStage(row.validated === true, 'matcher/finalize', `card "${row.card_name}" has validated=${row.validated}, expected true`)
    assertStage(typeof row.card_name === 'string' && row.card_name.trim().length > 0, 'matcher/finalize', `card ${row.id ?? '?'} missing card_name`)
    assertStage(typeof row.problem_text === 'string' && row.problem_text.trim().length > 0, 'matcher/finalize', `card "${row.card_name}" missing problem_text`)
    assertStage(typeof row.reasoning === 'string' && row.reasoning.trim().length > 0, 'matcher/finalize', `card "${row.card_name}" missing reasoning`)
    assertStage(row.suggested_offer && typeof row.suggested_offer === 'object', 'matcher/finalize', `card "${row.card_name}" missing suggested_offer`)
    assertStage(
      typeof row.suggested_offer.angle_note === 'string' && row.suggested_offer.angle_note.trim().length > 0,
      'matcher/finalize',
      `card "${row.card_name}" suggested_offer.angle_note is empty (contract: always populated, never null)`
    )
  }
  console.log(`  ${finalized.length} card(s) created, all validated=true:`)
  // name/format/price_point are contractually null when the coach already has
  // an existing offer (SuggestedOffer — see lib/matcherAnalysis.ts), so they're
  // only flagged as an anomaly when the intake said there was NO existing offer.
  const hasExistingOffer = finalStructured ? finalStructured.has_existing_offer : undefined
  for (const row of finalized) {
    console.log(`    "${row.card_name}"`)
    console.log(`      problem_text    : ${trunc(row.problem_text, 140)}`)
    console.log(`      reasoning       : ${trunc(row.reasoning, 140)}`)
    console.log(`      suggested_offer : name=${JSON.stringify(row.suggested_offer.name)} format=${JSON.stringify(row.suggested_offer.format)} price_point=${JSON.stringify(row.suggested_offer.price_point)}`)
    console.log(`                        angle_note=${trunc(row.suggested_offer.angle_note, 120)}`)
    if (hasExistingOffer === false) {
      if (isEmptyVal(row.suggested_offer.name)) pipelineIssues.push(`card "${row.card_name}": suggested_offer.name empty (expected populated — intake said no existing offer)`)
      if (isEmptyVal(row.suggested_offer.format)) pipelineIssues.push(`card "${row.card_name}": suggested_offer.format empty (expected populated — intake said no existing offer)`)
      if (isEmptyVal(row.suggested_offer.price_point)) pipelineIssues.push(`card "${row.card_name}": suggested_offer.price_point empty (expected populated — intake said no existing offer)`)
    }
  }
  pipelineIssues.push(...checkDistinctText(finalized, (r) => r.problem_text, 'finalized cards[].problem_text'))
  pipelineIssues.push(...checkDistinctText(finalized, (r) => r.suggested_offer?.angle_note ?? '', 'finalized cards[].suggested_offer.angle_note'))

  // ── Pipeline summary ──
  console.log('\n' + '━'.repeat(70))
  console.log('MATCHER PIPELINE SUMMARY')
  console.log('━'.repeat(70))
  console.log('Stage results     : all 3 stages reached their expected state ✅')
  console.log(`Top 10            : exactly 10 (${analysis.top_10.map((p) => p.id).join(', ')}) ✅`)
  console.log(`Finalized cards   : exactly 3, all validated=true (${finalized.map((r) => `"${r.card_name}"`).join(', ')}) ✅`)
  console.log('\nAnomaly scan (Matcher pipeline):')
  console.log(`  narration-leak scan: covered by the intake conversation turns above (${leaks.length ? `${leaks.length} leak(s) found — see above` : '✓ none found'})`)
  if (pipelineIssues.length) pipelineIssues.forEach((i) => console.log(`  ⚠ ${i}`))
  else console.log('  ✓ no empty nested fields, no duplicate/templated top_10 or finalized-card text')
}

// plain verdict
const clean = completedReached && !answersExhausted &&
  (!expectedFields || expectedFields.every((f) => finalStructured && !isEmptyVal(finalStructured[f]))) &&
  emptyFields.length === 0 && arrayIssues.length === 0 && leaks.length === 0 &&
  (!pipelineRan || pipelineIssues.length === 0)
console.log('\n' + '━'.repeat(70))
console.log(clean ? 'VERDICT: ✅ clean run — completed, all fields populated, no anomalies.'
                  : 'VERDICT: ⚠ review the warnings above.')
console.log('━'.repeat(70))
process.exit(clean ? 0 : 1)
