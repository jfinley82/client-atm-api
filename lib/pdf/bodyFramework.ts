import { esc, str, strArray } from './html'
import {
  Block,
  sectionHead,
  sub,
  body,
  list,
  callout,
  twoup,
  stats,
  divider,
} from './shell'

// The framework blueprint body — the FULL Steps 1-3 output (Attract / Transform /
// Monetize) formatted into the interior shell, NOT the trimmed on-page summary.
// Mirrors the Framework page's field map. Each step is skipped only when its
// results section status !== 'ready'. Field access is defensive (the results
// payload mixes camelCase and snake_case), so a missing field degrades to nothing
// rather than crashing.

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})

// First non-empty string across key variants.
function pick(o: Any, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return ''
}
// First array across key variants.
function pickArr(o: Any, ...keys: string[]): unknown[] {
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[]
  return []
}
// Parse a leading currency-ish number out of a price string ("$5,000/mo" -> 5000).
function money(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const m = String(v ?? '').replace(/[, ]/g, '').match(/(\d+(?:\.\d+)?)/)
  return m ? Math.round(parseFloat(m[1])) : 0
}
const usd = (n: number) => '$' + n.toLocaleString('en-US')
const bold = (label: string, rest: string) => `<b>${esc(label)}</b>${rest ? ' — ' + esc(rest) : ''}`

// A labelled sub + paragraph, emitted only when the value is present.
function field(blocks: Block[], label: string, value: string) {
  if (!value) return
  blocks.push(sub(label))
  blocks.push(body(esc(value), value.length))
}

export function buildFrameworkBlocks(results: Any): { docTitle: string; blocks: Block[] } {
  const blocks: Block[] = []
  const fw = obj(obj(results.framework).framework)
  const docTitle = pick(fw, 'frameworkName', 'framework_name') || 'Your framework'

  // ── STEP 1 — ATTRACT ──────────────────────────────────────────────────────
  const audSec = obj(results.audience)
  if (audSec.status === 'ready') {
    const a = obj(audSec.profile)
    blocks.push(sectionHead('Step 1 · Attract', 'Your ideal client', pick(a, 'problemStatement', 'problem_statement')))
    const emotion = pick(a, 'emotional_state', 'emotionalState')
    if (emotion) blocks.push(body(`<strong>Emotional state.</strong> ${esc(emotion)}`, emotion.length + 16))
    field(blocks, 'The real problem', pick(a, 'realProblem', 'real_problem'))
    field(blocks, 'The core gap', pick(a, 'gapInsight', 'gap_insight'))
    field(blocks, 'What they want', pick(a, 'dreamOutcome', 'dream_outcome'))
    field(blocks, 'How to connect with them', pick(a, 'connectionSummary', 'connection_summary'))
    const pains = strArray(a.painPoints ?? a.pain_points)
    if (pains.length) { blocks.push(sub('Pain points')); blocks.push(list(pains.map(esc))) }
    const fears = strArray(a.fearsAndDoubts ?? a.fears_and_doubts)
    if (fears.length) { blocks.push(sub('Fears and doubts')); blocks.push(list(fears.map(esc))) }
    const objs = strArray(a.objections) // single-cased in the audience block
    if (objs.length) { blocks.push(sub('Sales objections')); blocks.push(list(objs.map(esc))) }
    blocks.push(divider())
  }

  // ── STEP 2 — TRANSFORM ────────────────────────────────────────────────────
  const trSec = obj(results.transformation)
  if (trSec.status === 'ready') {
    const t = obj(trSec.analysis)
    blocks.push(sectionHead('Step 2 · Transform', 'The transformation you sell', pick(t, 'zoneOfImpact', 'zone_of_impact')))
    const before = pick(t, 'beforeState', 'before_state')
    const after = pick(t, 'afterState', 'after_state')
    if (before || after) {
      blocks.push(twoup({ h4: 'From this', body: before }, { h4: 'To this', body: after, win: true }))
    }
    const intersection = strArray(t.intersection)
    if (intersection.length) { blocks.push(sub('Why this method wins')); blocks.push(list(intersection.map(esc))) }

    // The named framework
    if (fw && (pick(fw, 'frameworkName', 'framework_name') || pickArr(fw, 'phases').length)) {
      const name = pick(fw, 'frameworkName', 'framework_name')
      const tagline = pick(fw, 'frameworkTagline', 'framework_tagline')
      blocks.push(sub(name || 'Your named framework'))
      if (tagline) blocks.push(body(`<strong>${esc(tagline)}</strong>`, tagline.length))
      const desc = pick(fw, 'descriptiveCopy', 'descriptive_copy', 'description')
      if (desc) blocks.push(body(esc(desc), desc.length))
      for (const pRaw of pickArr(fw, 'phases')) {
        const p = obj(pRaw)
        const pn = pick(p, 'name', 'phase_name')
        const pt = pick(p, 'tagline')
        if (!pn && !pickArr(p, 'steps').length) continue
        blocks.push(sub(pt ? `${pn}: ${pt}` : pn))
        const steps = pickArr(p, 'steps').map((sRaw) => {
          const s = obj(sRaw)
          return bold(pick(s, 'name', 'step_name'), pick(s, 'outcome', 'result'))
        })
        if (steps.length) blocks.push(list(steps))
      }
      const useCases = strArray(fw.useCases ?? fw.use_cases)
      if (useCases.length) { blocks.push(sub('Where to use it')); blocks.push(list(useCases.map(esc))) }
    }

    // The three validated blueprints — full synopsis each
    const items = pickArr(obj(results.blueprints), 'items')
    const strongestId = items
      .map((it) => obj(it))
      .reduce<{ id: unknown; s: number } | null>((best, it) => {
        const s = Number(it.match_strength ?? 0)
        return !best || s > best.s ? { id: it.id, s } : best
      }, null)?.id
    if (items.length) blocks.push(sub('Your validated blueprints'))
    items.forEach((itRaw) => {
      const it = obj(itRaw)
      const syn = obj(it.synopsis)
      const label = it.id === strongestId ? ' (strongest match)' : ''
      const problem = pick(it, 'problem_text', 'problemText')
      blocks.push(body(`<strong>${esc(problem)}${esc(label)}</strong>`, problem.length + label.length))
      field(blocks, 'The solution', pick(syn, 'solution_summary'))
      const quote = pick(syn, 'audience_quote')
      if (quote) blocks.push(callout(quote))
      field(blocks, "What it's costing them", pick(syn, 'cost_of_inaction'))
      field(blocks, 'The objection it dissolves', pick(syn, 'objection_dissolved'))
      const tr = obj(syn.transformation)
      const b2 = pick(tr, 'before')
      const a2 = pick(tr, 'after')
      if (b2 || a2) blocks.push(twoup({ h4: 'Before', body: b2 }, { h4: 'After', body: a2, win: true }))
      const fit = obj(syn.framework_fit)
      const fitPhase = pick(fit, 'phase_name')
      const fitNote = pick(fit, 'note')
      if (fitPhase || fitNote) blocks.push(body(`<strong>Framework fit.</strong> ${esc([fitPhase, fitNote].filter(Boolean).join(' — '))}`, 80))
      const trainingTitle = pick(syn, 'training_title')
      if (trainingTitle) blocks.push(sub(`The training: ${trainingTitle}`))
      const outline = pickArr(syn, 'teaching_outline').map((oRaw) => {
        const o = obj(oRaw)
        return bold(pick(o, 'point'), pick(o, 'detail'))
      }).filter((x) => x.length > 3)
      if (outline.length) blocks.push(list(outline))
      blocks.push(divider())
    })
  }

  // ── STEP 3 — MONETIZE ─────────────────────────────────────────────────────
  const progSec = obj(results.program)
  const coSec = obj(results.core_offers)
  const co = obj(coSec.core_offers)
  if (progSec.status === 'ready' || coSec.status === 'ready') {
    const p = obj(progSec.program)
    const ht = obj(co.high_ticket)
    blocks.push(sectionHead('Step 3 · Monetize', pick(p, 'program_name', 'name') || 'Your program', pick(ht, 'name')))
    field(blocks, 'Who it is for', pick(ht, 'who_its_for', 'who_it_is_for'))
    const inc = strArray(ht.whats_included ?? ht.included)
    if (inc.length) { blocks.push(sub("What's included")); blocks.push(list(inc.map(esc))) }
    // delivery shape
    const shape = [
      pick(p, 'session_type'),
      pick(p, 'total_weeks') && `${pick(p, 'total_weeks')} weeks`,
      pick(p, 'session_length_minutes') && `${pick(p, 'session_length_minutes')} min sessions`,
    ].filter(Boolean).join(' · ')
    if (shape) blocks.push(body(`<strong>Delivery.</strong> ${esc(shape)}`, shape.length + 12))
    field(blocks, 'Why this shape', pick(p, 'timeline_reasoning'))
    const weeks = pickArr(p, 'weekly_breakdown').map((wRaw) => {
      const w = obj(wRaw)
      const head = `Week ${pick(w, 'week') || ''} · ${pick(w, 'phase_name')}`.trim()
      const rest = [pick(w, 'session_focus'), pick(w, 'client_milestone') && `client milestone: ${pick(w, 'client_milestone')}`].filter(Boolean).join('; ')
      return bold(head, rest)
    })
    if (weeks.length) { blocks.push(sub('Week by week')); blocks.push(list(weeks)) }
    const deliverables = strArray(p.deliverables)
    if (deliverables.length) { blocks.push(sub('Deliverables')); blocks.push(list(deliverables.map(esc))) }
    blocks.push(divider())

    // The offer ladder — three tiers, full detail
    const tiers: { key: string; label: string; win?: boolean }[] = [
      { key: 'low_ticket', label: 'Entry offer' },
      { key: 'mid_ticket', label: 'Group offer' },
      { key: 'high_ticket', label: 'High-ticket offer', win: true },
    ]
    blocks.push(sub('Your offer ladder'))
    for (const tier of tiers) {
      const o = obj(co[tier.key])
      if (!pick(o, 'name') && !pick(o, 'price_point')) continue
      const heading = `${tier.label}: ${pick(o, 'name')}${pick(o, 'price_point') ? ` (${pick(o, 'price_point')})` : ''}${tier.win ? ' — primary' : ''}`
      blocks.push(body(`<strong>${esc(heading)}</strong>`, heading.length))
      field(blocks, 'Why this price', pick(o, 'why_this_price'))
      const wi = strArray(o.whats_included ?? o.included)
      if (wi.length) { blocks.push(sub("What's included")); blocks.push(list(wi.map(esc))) }
      else field(blocks, "What's included", pick(o, 'whats_included'))
      field(blocks, 'Delivery', pick(o, 'delivery_format'))
      field(blocks, 'Why it fits', pick(o, 'why_it_fits'))
    }
    blocks.push(divider())

    // Revenue potential (static computed values)
    const price = money(pick(p, 'suggested_starting_price') || pick(obj(co.high_ticket), 'price_point'))
    const clients = money(pick(p, 'suggested_capacity_per_month')) || 3
    const monthly = price * clients
    if (price > 0) {
      blocks.push(sub('Revenue potential'))
      blocks.push(stats([
        { lab: 'Average price', val: usd(price) },
        { lab: 'Clients / month', val: String(clients) },
        { lab: 'Monthly', val: usd(monthly), green: true },
        { lab: 'Annual', val: usd(monthly * 12), green: true },
      ]))
    }
  }

  blocks.push(body(
    'This document is generated from your own framework and offer. Edit any section in the app and your next download reflects the change.',
    140
  ))
  return { docTitle, blocks }
}
