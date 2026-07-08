#!/usr/bin/env node
// Scripted exerciser for the 4 Toolkits (program, content, slides, qualifier).
//
// Unlike scripts/run-conversation.mjs, these 4 tools have no conversational
// turn loop of their own — each is a direct one-shot POST against an ALREADY
// fully-set-up account (audience completed, transformation confirmed,
// framework confirmed, core_offers confirmed, 3 validated blueprint cards).
// That structural difference is why this is a sibling script rather than an
// extension of run-conversation.mjs's per-turn loop — trying to bolt a
// "skip the conversation, just POST" mode onto that script's turn-based
// design would add more branching than it would save. The small set of pure
// presentational helpers below (trunc/isEmptyVal/checkDistinctText/
// deepEmptyFields) are intentionally duplicated from run-conversation.mjs —
// they're a few lines each, zero external dependencies, and this mirrors how
// the mock-server test scripts already exist as fully independent files
// tonight. That's a different class of duplication from the extractJson
// mistake (a correctness-critical PRODUCTION function, not a test script's
// pretty-printer).
//
// It hits the real endpoints — it does NOT mock or bypass anything — so it
// upserts the test user's saved_outputs rows just like a real session would.
//
// Usage:
//   CATM_TOKEN=<jwt> node scripts/run-toolkits.mjs --card-id <validated-blueprint-id>
//   node scripts/run-toolkits.mjs --token <jwt> --base <url> --card-id <id> --platform claude
//
// If --card-id is omitted, the slides and qualifier stages are skipped with a
// clear note (there is currently no live endpoint that LISTS a user's
// validated problem_solution_cards ids — /api/cards was deprecated tonight,
// and the only remaining reads of that table return card_name, not id. The
// real card_id has to come from where the Vibe frontend would already have
// it: the response of POST /api/matcher/finalize, which returns the full
// inserted rows including their ids. Grab one from there, or query
// problem_solution_cards directly, and pass it via --card-id.)

import { readFileSync } from 'node:fs'

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { flags[key] = true }
    else { flags[key] = next; i++ }
  }
}

const DEFAULT_BASE = 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'
const base = (flags.base || process.env.API_BASE || DEFAULT_BASE).replace(/\/+$/, '')
const token = flags.token || process.env.CATM_TOKEN || ''
const cardId = typeof flags['card-id'] === 'string' ? flags['card-id'] : undefined
const platform = typeof flags.platform === 'string' ? flags.platform : 'chatgpt'
const verbose = !!flags.verbose

if (!token) {
  console.error('ERROR: no auth token. Pass --token <jwt> or set CATM_TOKEN.\n' +
    'This must be a real session JWT for the test account (the same "Bearer" token the browser sends).')
  process.exit(2)
}

// ─── helpers (small, pure, intentionally duplicated — see header note) ─────
const trunc = (s, n = 220) => {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) + '…' : str
}
const isEmptyVal = (v) =>
  v == null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0)

function deepEmptyFields(obj, prefix = '') {
  const out = []
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id' || k === 'color' || k === 'confirmed') continue
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...deepEmptyFields(v, path))
    else if (isEmptyVal(v)) out.push(path)
  }
  return out
}

function checkDistinctText(items, getText, label) {
  const texts = items.map(getText)
  const seen = new Set(), dups = new Set()
  for (const t of texts) { if (seen.has(t)) dups.add(t); seen.add(t) }
  return dups.size ? [`${label}: ${dups.size} of ${items.length} entries are textually identical`] : []
}

// ── max_tokens ceilings, mirrored from source (confirmed before writing this
// script, not from memory): lib/programAnalysis.ts, lib/contentAnalysis.ts,
// lib/slidesAnalysis.ts, lib/qualifierAnalysis.ts. If those change, update
// here too — this is a maintenance point, same as run-conversation.mjs's
// SCHEMA_FIELDS constant. ──
const MAX_TOKENS_CEILING = { program: 4000, content: 8000, slides: 6000, qualifier: 3000 }
const TRUNCATION_WARNING_THRESHOLD = 0.75

// Rough heuristic (~4 chars/token for English text) applied to the
// stringified response — this is an early-warning proxy, NOT Anthropic's own
// usage.output_tokens, which none of these endpoints currently surface over
// HTTP. Good enough to catch "this is already close to the ceiling before a
// single real-world account pushes it over," same failure class as Matcher's
// earlier 500.
function estimateTokensFromResponse(responseObj) {
  return Math.ceil(JSON.stringify(responseObj).length / 4)
}

function reportTokenProximity(toolName, responseObj, issues) {
  const ceiling = MAX_TOKENS_CEILING[toolName]
  const estimate = estimateTokensFromResponse(responseObj)
  const pct = estimate / ceiling
  console.log(`  max_tokens headroom: ~${estimate} est. tokens / ${ceiling} ceiling (${(pct * 100).toFixed(0)}%)`)
  if (pct >= TRUNCATION_WARNING_THRESHOLD) {
    issues.push(`${toolName}: response used ~${(pct * 100).toFixed(0)}% of its ${ceiling}-token ceiling — raise max_tokens before this becomes a live truncation bug (same pattern as Matcher's earlier 500)`)
  }
}

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
    if (res.status === 502) hint = ' (502 → check the error code below: "generation_truncated" means max_tokens was actually hit for real, not just close to it)'
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

function assertStage(condition, stageLabel, detail) {
  if (condition) return
  console.error(`\n✖ STAGE FAILED: ${stageLabel}\n  ${detail}`)
  process.exit(1)
}

// ─── run ─────────────────────────────────────────────────────────────────────
console.log('━'.repeat(70))
console.log('Toolkits exerciser')
console.log(`base: ${base}`)
console.log(`card-id: ${cardId ?? '(none provided — slides/qualifier will be skipped)'}`)
console.log(`platform: ${platform}`)
console.log('━'.repeat(70))

{
  const rawLen = token.length
  const trimmed = token.trim()
  const edgeWs = rawLen - trimmed.length
  const jwtShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)
  const mask = (t) => (t.length <= 20 ? '<suspiciously short>' : `${t.slice(0, 12)}…${t.slice(-6)}`)
  console.log('auth preflight:')
  console.log(`  header sent : "Authorization: Bearer ${mask(token)}"`)
  console.log(`  leading/trailing whitespace: ${edgeWs ? `YES ⚠  (${edgeWs} char(s) — this is very likely a 401 cause)` : 'none'}`)
  console.log(`  JWT shape (3 base64url parts): ${jwtShape ? 'ok' : 'NO ⚠  (does not look like a header.payload.signature JWT)'}`)
}
console.log('━'.repeat(70))

const allIssues = []   // soft anomalies across every stage — flips final VERDICT
let stagesRun = 0

// ── program ──
console.log('\n[program] POST /api/toolkits/program/analyze')
{
  const result = await postJson('/api/toolkits/program/analyze', {}, 'program/analyze')
  stagesRun++
  assertStage(!!result.program_name, 'program/analyze', 'program_name missing/empty')
  assertStage(
    Array.isArray(result.weekly_breakdown) && result.weekly_breakdown.length === result.total_weeks,
    'program/analyze',
    `weekly_breakdown length (${result.weekly_breakdown?.length}) must equal total_weeks (${result.total_weeks})`
  )
  assertStage(
    Array.isArray(result.deliverables) && result.deliverables.length >= 4 && result.deliverables.length <= 6,
    'program/analyze',
    `deliverables must have 4-6 entries, got ${Array.isArray(result.deliverables) ? result.deliverables.length : typeof result.deliverables}`
  )
  console.log(`  program_name: ${trunc(result.program_name, 80)}`)
  console.log(`  session_type: ${result.session_type}  |  ${result.total_weeks} weeks, ${result.total_sessions} sessions, ${result.session_length_minutes}min`)
  console.log(`  suggested_starting_price: ${result.suggested_starting_price}  |  capacity/mo: ${result.suggested_capacity_per_month}`)
  console.log(`  weekly_breakdown: ${result.weekly_breakdown.length} weeks`)
  if (verbose) result.weekly_breakdown.forEach((w) => console.log(`    week ${w.week} [${w.phase_name}]: ${trunc(w.session_focus, 100)}`))
  console.log(`  deliverables: ${result.deliverables.length} entries`)

  const empties = deepEmptyFields(result)
  if (empties.length) allIssues.push(...empties.map((e) => `program: empty field — ${e}`))
  allIssues.push(...checkDistinctText(result.weekly_breakdown, (w) => w.session_focus, 'program.weekly_breakdown[].session_focus'))
  allIssues.push(...checkDistinctText(result.weekly_breakdown, (w) => w.client_milestone, 'program.weekly_breakdown[].client_milestone'))
  allIssues.push(...checkDistinctText(result.deliverables.map((d) => ({ d })), (x) => x.d, 'program.deliverables'))
  reportTokenProximity('program', result, allIssues)
}

// ── content (twice: default/skipped intake, then explicit intake) ──
const CATEGORIES = ['Authority', 'Story', 'Problem-Aware', 'Offer/CTA', 'Engagement']

async function runContent(body, label) {
  console.log(`\n[content — ${label}] POST /api/toolkits/content/analyze`)
  const result = await postJson('/api/toolkits/content/analyze', body, `content/analyze (${label})`)
  stagesRun++
  assertStage(Array.isArray(result.posts) && result.posts.length === 15, `content/analyze (${label})`, `expected exactly 15 posts, got ${result.posts?.length}`)
  assertStage(Array.isArray(result.emails) && result.emails.length === 5, `content/analyze (${label})`, `expected exactly 5 emails, got ${result.emails?.length}`)

  for (const cat of CATEGORIES) {
    const count = result.posts.filter((p) => p.category === cat).length
    assertStage(count === 3, `content/analyze (${label})`, `category "${cat}" has ${count} posts, expected exactly 3`)
  }

  console.log(`  posts: 15 (3 per category × 5 categories) | emails: 5`)
  if (verbose) {
    result.posts.forEach((p) => console.log(`    ${p.id} [${p.category}]: ${trunc(p.caption, 90)}`))
    result.emails.forEach((e) => console.log(`    ${e.id} [${e.type}]: ${trunc(e.subject, 60)}`))
  }

  const empties = deepEmptyFields(result)
  if (empties.length) allIssues.push(...empties.map((e) => `content (${label}): empty field — ${e}`))
  allIssues.push(...checkDistinctText(result.posts, (p) => p.caption, `content (${label}).posts[].caption`))
  allIssues.push(...checkDistinctText(result.emails, (e) => e.subject, `content (${label}).emails[].subject`))
  allIssues.push(...checkDistinctText(result.emails, (e) => e.body, `content (${label}).emails[].body`))
  reportTokenProximity('content', result, allIssues)
  return result
}

await runContent({}, 'default, no intake')
await runContent({ platform: 'LinkedIn', tone: 'professional' }, 'explicit intake: LinkedIn/professional')

// ── slides (requires --card-id) ──
if (cardId) {
  console.log('\n[slides] POST /api/toolkits/slides/analyze')
  const result = await postJson('/api/toolkits/slides/analyze', { card_id: cardId }, 'slides/analyze')
  stagesRun++
  assertStage(!!result.training_title, 'slides/analyze', 'training_title missing/empty')
  assertStage(
    Array.isArray(result.slides) && result.slides.length >= 10 && result.slides.length <= 12,
    'slides/analyze',
    `expected 10-12 slides, got ${Array.isArray(result.slides) ? result.slides.length : typeof result.slides}`
  )
  const sequential = result.slides.every((s, i) => s.slide_number === i + 1)
  assertStage(sequential, 'slides/analyze', 'slide_number values are not sequential starting at 1')

  console.log(`  training_title: ${trunc(result.training_title, 80)}`)
  console.log(`  duration_estimate: ${result.duration_estimate}  |  ${result.slides.length} slides`)
  console.log(`  final slide (manual eyeball for CTA/suggested_offer grounding):`)
  const finalSlide = result.slides[result.slides.length - 1]
  console.log(`    "${finalSlide.title}" — ${trunc(finalSlide.speaker_notes, 200)}`)
  if (verbose) result.slides.forEach((s) => console.log(`    slide ${s.slide_number}: ${trunc(s.title, 70)}`))

  const empties = deepEmptyFields(result)
  if (empties.length) allIssues.push(...empties.map((e) => `slides: empty field — ${e}`))
  allIssues.push(...checkDistinctText(result.slides, (s) => s.title, 'slides[].title'))
  allIssues.push(...checkDistinctText(result.slides, (s) => s.speaker_notes, 'slides[].speaker_notes'))
  reportTokenProximity('slides', result, allIssues)
} else {
  console.log('\n[slides] SKIPPED — no --card-id provided')
}

// ── qualifier (requires --card-id) ──
if (cardId) {
  console.log(`\n[qualifier] POST /api/toolkits/qualifier/analyze (platform=${platform})`)
  const result = await postJson('/api/toolkits/qualifier/analyze', { card_id: cardId, platform }, 'qualifier/analyze')
  stagesRun++
  assertStage(!!result.coach_name, 'qualifier/analyze', 'coach_name missing/empty')
  assertStage(!!result.system_prompt, 'qualifier/analyze', 'system_prompt missing/empty')
  assertStage(!!result.deployment_instructions, 'qualifier/analyze', 'deployment_instructions missing/empty')

  console.log(`  coach_name: ${result.coach_name}`)
  console.log(`  system_prompt length: ${result.system_prompt.length} chars`)
  console.log(`  deployment_instructions: ${trunc(result.deployment_instructions, 200)}`)
  if (verbose) console.log(`  full system_prompt:\n${result.system_prompt.split('\n').map((l) => '    ' + l).join('\n')}`)

  // Soft signal only — exact wording isn't guaranteed, just a sanity check
  // that deployment_instructions actually varies with the requested platform.
  const platformMentioned = result.deployment_instructions.toLowerCase().includes(platform.toLowerCase())
    || (platform === 'chatgpt' && /custom gpt|chatgpt/i.test(result.deployment_instructions))
    || (platform === 'claude' && /claude|project/i.test(result.deployment_instructions))
  if (!platformMentioned) allIssues.push(`qualifier: deployment_instructions doesn't obviously reference the requested platform "${platform}" — spot-check it`)

  const empties = deepEmptyFields(result)
  if (empties.length) allIssues.push(...empties.map((e) => `qualifier: empty field — ${e}`))
  reportTokenProximity('qualifier', result, allIssues)
} else {
  console.log('\n[qualifier] SKIPPED — no --card-id provided')
}

// ─── summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '━'.repeat(70))
console.log('SUMMARY')
console.log('━'.repeat(70))
console.log(`Stages run: ${stagesRun} / 4 tool endpoints (program, content×2, slides, qualifier)${cardId ? '' : ' — slides/qualifier skipped (no --card-id)'}`)
console.log('\nAnomaly scan:')
console.log('  narration-leak scan: not applicable — no conversational message channel in any of these 4 tools, only direct JSON responses')
if (allIssues.length) allIssues.forEach((i) => console.log(`  ⚠ ${i}`))
else console.log('  ✓ no empty fields, no duplicate/templated content, no max_tokens proximity warnings')

const clean = allIssues.length === 0
console.log('\n' + '━'.repeat(70))
console.log(clean ? 'VERDICT: ✅ clean run — all stages populated, no anomalies.' : 'VERDICT: ⚠ review the warnings above.')
console.log('━'.repeat(70))
process.exit(clean ? 0 : 1)
