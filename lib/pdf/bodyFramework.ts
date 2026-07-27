import { esc, strArray } from './html'
import {
  StepSection,
  Block,
  sectionTitle,
  subHead,
  para,
  avatarBand,
  cardGrid,
  rowsList,
  heroBand,
  fromTo,
  deepStrip,
  phaseCards,
  tierRow,
  offerDetail,
  programTable,
  blueprintCard,
  BlueprintData,
  stats,
} from './shell'

// The framework blueprint body — the FULL Steps 1-3 output (Attract / Transform /
// Monetize) rendered as the redesigned "keepsake" document: three chalkboard step
// dividers, each followed by paginated content built from the mockup's component
// vocabulary. Returns the doc title (framework name, for the running header) and
// one StepSection per step (divider + blocks). Field access is defensive — the
// results payload mixes camelCase and snake_case, and a missing field degrades to
// nothing rather than crashing.

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
// Like pick, but also accepts numbers (program stores week/total_weeks/etc. as numbers).
function pickVal(o: Any, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}
function pickArr(o: Any, ...keys: string[]): unknown[] {
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[]
  return []
}
function money(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const m = String(v ?? '').replace(/[, ]/g, '').match(/(\d+(?:\.\d+)?)/)
  return m ? Math.round(parseFloat(m[1])) : 0
}
const usd = (n: number) => '$' + n.toLocaleString('en-US')
function firstSentence(s: string): string {
  const t = s.trim()
  const m = t.match(/^(.*?[.!?])(\s|$)/)
  return (m ? m[1] : t).trim()
}
// Split a "$27/mo" style price into { price, unit }.
function splitPrice(p: string): { price: string; unit?: string } {
  const m = p.match(/^(.*?)\s*(\/\s*(?:mo|month|yr|year))\s*$/i)
  return m ? { price: m[1].trim(), unit: m[2].replace(/\s+/g, '') } : { price: p }
}

export function buildFrameworkDoc(results: Any): { docTitle: string; sections: StepSection[] } {
  const fw = obj(obj(results.framework).framework)
  const docTitle = pick(fw, 'frameworkName', 'framework_name') || 'Your framework'
  const sections: StepSection[] = []

  // ── STEP 1 — ATTRACT ───────────────────────────────────────────────────────
  {
    const blocks: Block[] = []
    const audSec = obj(results.audience)
    const a = obj(audSec.profile)
    const ready = audSec.status === 'ready'

    const problemStatement = pick(a, 'problemStatement', 'problem_statement')
    const realProblem = pick(a, 'realProblem', 'real_problem')
    const gapInsight = pick(a, 'gapInsight', 'gap_insight')
    const dreamOutcome = pick(a, 'dreamOutcome', 'dream_outcome')
    const connection = pick(a, 'connectionSummary', 'connection_summary')
    const emotion = pick(a, 'emotional_state', 'emotionalState')
    const avatarName = pick(a, 'avatarName', 'avatar_name')

    blocks.push(sectionTitle('client', 'Step 1 · Attract', 'Your ideal client', realProblem || problemStatement || undefined))

    if (ready && (avatarName || problemStatement)) {
      const name = avatarName || 'Your ideal client'
      blocks.push(avatarBand(name.charAt(0).toUpperCase() || 'C', name, problemStatement, emotion || undefined))
    }

    const cards = [
      { label: 'The real problem', text: realProblem },
      { label: 'The core gap', text: gapInsight },
      { label: 'What they want', text: dreamOutcome },
      { label: 'How to connect', text: connection },
    ].filter((c) => c.text)
    if (cards.length) blocks.push(cardGrid(cards))

    const inHead = pick(a, 'internal_dialogue', 'internalDialogue', 'their_world', 'theirWorld', 'perceivedProblem', 'perceived_problem')
    if (inHead) {
      blocks.push(subHead('In their own head', 'deeper context'))
      blocks.push(para(esc(inHead), inHead.length))
    }

    // What's really going on
    const pains = strArray(a.painPoints ?? a.pain_points)
    const fears = strArray(a.fearsAndDoubts ?? a.fears_and_doubts)
    const objs = strArray(a.objections)
    if (pains.length || fears.length || objs.length) {
      blocks.push(sectionTitle('layers', 'Step 1 · Attract', "What's really going on for them",
        'The pains they feel, the fears underneath, and the objections they will voice on a call. Speak to these and the right person feels seen.'))
      if (pains.length) { blocks.push(subHead('Pain points')); blocks.push(rowsList(pains, 'num')) }
      if (fears.length) { blocks.push(subHead('Fears and doubts')); blocks.push(rowsList(fears, 'num')) }
      if (objs.length) { blocks.push(subHead('Sales objections')); blocks.push(rowsList(objs, 'num')) }
    }

    sections.push({ divider: { n: '01', name: 'Attract', line: 'Who this is for, and the real problem underneath what they say.', active: 'A' }, blocks })
  }

  // ── STEP 2 — TRANSFORM ─────────────────────────────────────────────────────
  {
    const blocks: Block[] = []
    const trSec = obj(results.transformation)
    const t = obj(trSec.analysis)

    if (trSec.status === 'ready') {
      blocks.push(sectionTitle('transform', 'Step 2 · Transform', 'The transformation you sell'))
      const zone = pick(t, 'zoneOfImpact', 'zone_of_impact')
      if (zone) blocks.push(heroBand('Your zone of impact', zone))
      const before = pick(t, 'beforeState', 'before_state')
      const after = pick(t, 'afterState', 'after_state')
      if (before || after) blocks.push(fromTo(before, after))

      // Underneath the change — from the selected problem candidate.
      const problems = pickArr(t, 'selectedProblems', 'selected_problems').map(obj)
      const selId = pick(t, 'selected_id', 'selectedId')
      const sel = problems.find((p) => p.id === selId) || problems[0] || {}
      const deep = [
        { label: 'Root cause', text: pick(obj(sel.rootCause), 'corePattern', 'core_pattern') },
        { label: 'What they really want', text: pick(obj(sel.rootDesire), 'emotionalDesire', 'emotional_desire') || pick(obj(sel.rootDesire), 'identityShift', 'identity_shift') },
        { label: 'Cost of waiting', text: pick(obj(sel.costOfInaction), 'inaction') },
      ].filter((d) => d.text)
      if (deep.length) { blocks.push(subHead('Underneath the change', 'why it holds')); blocks.push(deepStrip(deep)) }

      const intersection = strArray(t.intersection)
      if (intersection.length) { blocks.push(subHead('Why this method wins')); blocks.push(rowsList(intersection, 'check')) }
    }

    // The framework
    if (pick(fw, 'frameworkName', 'framework_name') || pickArr(fw, 'phases').length) {
      const name = pick(fw, 'frameworkName', 'framework_name') || 'Your named framework'
      blocks.push(sectionTitle('framework', 'Step 2 · Transform', name))
      const tagline = pick(fw, 'frameworkTagline', 'framework_tagline')
      if (tagline) blocks.push(para(`<b>${esc(tagline)}</b>`, tagline.length))
      const desc = pick(fw, 'descriptiveCopy', 'descriptive_copy', 'description')
      if (desc) blocks.push(para(esc(desc), desc.length))
      const phases = pickArr(fw, 'phases').map(obj).map((p) => ({
        name: pick(p, 'name', 'phase_name'),
        tagline: pick(p, 'tagline'),
        steps: pickArr(p, 'steps').map(obj).map((s) => ({ name: pick(s, 'name', 'step_name'), outcome: pick(s, 'outcome', 'result') })).filter((s) => s.name),
      })).filter((p) => p.name || p.steps.length)
      if (phases.length) blocks.push(phaseCards(phases))
    }

    // Validated blueprints
    const items = pickArr(obj(results.blueprints), 'items').map(obj)
    if (items.length) {
      blocks.push(sectionTitle('blueprints', 'Step 2 · Transform', 'Your validated blueprints',
        'The problems worth building a micro-training around. Each names a problem, the solution, and the short training that teaches it.'))
      const strongestId = items.reduce<{ id: unknown; s: number } | null>((best, it) => {
        const s = Number(it.match_strength ?? 0)
        return !best || s > best.s ? { id: it.id, s } : best
      }, null)?.id
      items.forEach((it, i) => {
        const syn = obj(it.synopsis)
        const tr = obj(syn.transformation)
        const fit = obj(syn.framework_fit)
        const fitText = [pick(fit, 'phase_name'), pick(fit, 'note')].filter(Boolean).join(' · ')
        const bp: BlueprintData = {
          no: String(i + 1).padStart(2, '0'),
          title: pick(it, 'problem_text', 'problemText'),
          badge: it.id === strongestId,
          solution: pick(syn, 'solution_summary'),
          quote: pick(syn, 'audience_quote'),
          cost: pick(syn, 'cost_of_inaction'),
          objection: pick(syn, 'objection_dissolved'),
          before: pick(tr, 'before'),
          after: pick(tr, 'after'),
          fit: fitText || undefined,
          mtTitle: pick(syn, 'training_title'),
          steps: pickArr(syn, 'teaching_outline').map(obj).map((o) => ({ point: pick(o, 'point'), detail: pick(o, 'detail') })).filter((s) => s.point),
        }
        blocks.push(blueprintCard(bp))
      })
    }

    sections.push({ divider: { n: '02', name: 'Transform', line: 'The change you sell, and the framework that delivers it.', active: 'T' }, blocks })
  }

  // ── STEP 3 — MONETIZE ──────────────────────────────────────────────────────
  {
    const blocks: Block[] = []
    const progSec = obj(results.program)
    const coSec = obj(results.core_offers)
    const co = obj(coSec.core_offers)
    const p = obj(progSec.program)

    // Phase → color class map (from the framework phase order).
    const phaseNames = pickArr(fw, 'phases').map(obj).map((ph) => pick(ph, 'name', 'phase_name'))
    const classCache = new Map<string, string>()
    const phaseClass = (nm: string): string => {
      const idx = phaseNames.indexOf(nm)
      if (idx >= 0) return `p${Math.min(idx + 1, 3)}`
      if (!classCache.has(nm)) classCache.set(nm, `p${Math.min(classCache.size + 1, 3)}`)
      return classCache.get(nm)!
    }

    // Program, week by week
    const weeks = pickArr(p, 'weekly_breakdown').map(obj)
    if (progSec.status === 'ready' && weeks.length) {
      const leadBits = [
        pick(p, 'session_type'),
        pickVal(p, 'total_weeks') && `${pickVal(p, 'total_weeks')} weeks`,
        pickVal(p, 'session_length_minutes') && `${pickVal(p, 'session_length_minutes')} min sessions`,
      ].filter(Boolean).join(' · ')
      blocks.push(sectionTitle('program', 'Step 3 · Monetize', 'Program, week by week', leadBits || undefined))
      blocks.push(programTable(weeks.map((w) => ({
        week: pickVal(w, 'week', 'week_number'),
        phase: pick(w, 'phase_name', 'phase'),
        phaseClass: phaseClass(pick(w, 'phase_name', 'phase')),
        focus: pick(w, 'session_focus', 'focus'),
        milestone: pick(w, 'client_milestone', 'milestone'),
      }))))
      const deliverables = strArray(p.deliverables)
      if (deliverables.length) { blocks.push(subHead('Deliverables')); blocks.push(rowsList(deliverables, 'num')) }
    }

    // Offer ladder
    const tierDefs = [
      { key: 'low_ticket', lab: 'Entry' },
      { key: 'mid_ticket', lab: 'Group' },
      { key: 'high_ticket', lab: 'High-ticket', hi: true },
    ]
    const presentTiers = tierDefs.map((d) => ({ ...d, o: obj(co[d.key]) })).filter((d) => pick(d.o, 'name') || pick(d.o, 'price_point'))
    if (coSec.status === 'ready' && presentTiers.length) {
      blocks.push(sectionTitle('offers', 'Step 3 · Monetize', 'Your offer ladder',
        'Ways to buy, from a low-friction entry to the primary program. The high-ticket program is the one everything points to.'))
      blocks.push(tierRow(presentTiers.map((d) => {
        const inc = strArray(d.o.whats_included ?? d.o.included)
        const one = pick(d.o, 'why_it_fits') || (inc.length ? firstSentence(inc[0]) : pick(d.o, 'whats_included'))
        const { price, unit } = splitPrice(pick(d.o, 'price_point'))
        return { lab: d.lab, name: pick(d.o, 'name'), price, unit, one, hi: !!d.hi }
      })))

      blocks.push(subHead('The detail, offer by offer'))
      for (const d of presentTiers) {
        const inc = strArray(d.o.whats_included ?? d.o.included)
        const included = inc.length ? inc.join('; ') : pick(d.o, 'whats_included')
        const kv = [
          { k: 'Why this price', v: pick(d.o, 'why_this_price') },
          { k: "What's included", v: included },
          { k: 'Delivery', v: pick(d.o, 'delivery_format') },
          { k: 'Why it fits', v: pick(d.o, 'why_it_fits') },
        ].filter((x) => x.v)
        blocks.push(offerDetail({ name: pick(d.o, 'name'), price: pick(d.o, 'price_point'), kv }))
      }
    }

    // Revenue potential
    const price = money(pick(p, 'suggested_starting_price') || pick(obj(co.high_ticket), 'price_point'))
    const clients = money(pickVal(p, 'suggested_capacity_per_month')) || 3
    if (price > 0) {
      const monthly = price * clients
      blocks.push(subHead('Revenue potential'))
      blocks.push(stats([
        { lab: 'Average price', val: usd(price) },
        { lab: 'Clients / month', val: String(clients) },
        { lab: 'Monthly', val: usd(monthly), green: true },
        { lab: 'Annual', val: usd(monthly * 12), green: true },
      ]))
    }

    blocks.push(para(
      'This document is generated from your own framework and offer. Edit any section in the app and your next download reflects the change.',
      140
    ))

    sections.push({ divider: { n: '03', name: 'Monetize', line: 'How the work becomes income, offer by offer.', active: 'M' }, blocks })
  }

  return { docTitle, sections }
}
