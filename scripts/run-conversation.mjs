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
  console.error('Usage: node scripts/run-conversation.mjs <spec.json> [--token <jwt>] [--base <url>] [--tool <t>] [--max-turns N] [--verbose]')
  process.exit(2)
}

const DEFAULT_BASE = 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'
const base = (flags.base || process.env.API_BASE || DEFAULT_BASE).replace(/\/+$/, '')
const token = flags.token || process.env.CATM_TOKEN || ''
const maxTurns = Number(flags['max-turns'] || 30)
const verbose = !!flags.verbose

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

// ─── run ─────────────────────────────────────────────────────────────────────
const url = `${base}/api/tools/${tool}`
console.log('━'.repeat(70))
console.log(`Conversation runner  ·  tool=${tool}`)
console.log(`POST ${url}`)
console.log(`answers: ${answers.length} scripted  ·  max turns: ${maxTurns}`)
console.log('━'.repeat(70))

const sessionHistory = []   // [{role, content}, ...] cumulative, exactly like the frontend
let prevStructured = null
let finalStructured = null
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
  if (structured_data != null) { prevStructured = structured_data; finalStructured = structured_data }

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

  if (completed === true) { completedReached = true; break }
  if (completed === undefined && step_complete === true) {
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

// plain verdict
const clean = completedReached && !answersExhausted &&
  (!expectedFields || expectedFields.every((f) => finalStructured && !isEmptyVal(finalStructured[f]))) &&
  emptyFields.length === 0 && arrayIssues.length === 0 && leaks.length === 0
console.log('\n' + '━'.repeat(70))
console.log(clean ? 'VERDICT: ✅ clean run — completed, all fields populated, no anomalies.'
                  : 'VERDICT: ⚠ review the warnings above.')
console.log('━'.repeat(70))
process.exit(clean ? 0 : 1)
