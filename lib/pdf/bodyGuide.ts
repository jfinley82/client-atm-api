import { esc, str, strArray } from './html'
import { Block, sectionHead, sub, body, list, callout } from './shell'

// The guide body — the coach's generated Guide (stored as the workbook jsonb on
// mtm_generations) poured into the interior shell with the same section
// vocabulary. Lead-facing, stands alone. docTitle (running header) is the
// framework name, passed in.

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})

export function buildGuideBlocks(workbook: unknown, frameworkName: string): { docTitle: string; blocks: Block[] } {
  const w = obj(workbook)
  const blocks: Block[] = []
  const title = str(w.title) || 'Your guide'
  blocks.push(sectionHead('Your guide', title, str(w.intro)))
  if (str(w.problem_intro)) blocks.push(body(esc(str(w.problem_intro)), str(w.problem_intro).length))
  if (str(w.understanding)) blocks.push(body(esc(str(w.understanding)), str(w.understanding).length))

  const sections = Array.isArray(w.sections) ? w.sections : []
  sections.forEach((sRaw) => {
    const s = obj(sRaw)
    const st = str(s.sectionTitle)
    if (st) blocks.push(sub(st))
    if (str(s.keyInsight)) blocks.push(body(esc(str(s.keyInsight)), str(s.keyInsight).length))
    const exercises = (Array.isArray(s.exercises) ? s.exercises : [])
      .map((eRaw) => str(obj(eRaw).prompt))
      .filter(Boolean)
    if (exercises.length) blocks.push(list(exercises.map(esc)))
    if (str(s.reflection)) blocks.push(body(esc(str(s.reflection)), str(s.reflection).length))
  })

  const takeaways = strArray(w.keyTakeaways)
  if (takeaways.length) { blocks.push(sub('Key takeaways')); blocks.push(list(takeaways.map(esc))) }

  const ci = obj(w.closing_invite)
  const close = str(ci.book_call) || str(ci.sell_program)
  if (close) blocks.push(callout(close))

  return { docTitle: frameworkName || title, blocks }
}
