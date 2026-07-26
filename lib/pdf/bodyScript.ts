import { esc, str, strArray } from './html'
import { Block, sectionHead, sub, body, list, divider } from './shell'

// The script body — the coach's generated call script (the sales_script beats on
// mtm_generations) poured into the interior shell. Keeps its own beat structure,
// styled with the shell's vocabulary rather than the app UI. docTitle (running
// header) is the framework name, passed in.

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})

export function buildScriptBlocks(salesScript: unknown, frameworkName: string): { docTitle: string; blocks: Block[] } {
  const beats = Array.isArray(salesScript) ? salesScript : []
  const blocks: Block[] = []
  blocks.push(sectionHead('Your offer script', 'The call, beat by beat', 'What to say at each moment of the conversation, in your own words.'))

  beats.forEach((bRaw) => {
    const b = obj(bRaw)
    const beat = str(b.beat)
    if (beat) blocks.push(sub(beat))
    if (str(b.prospect_mindset)) {
      blocks.push(body(`<strong>Where their head is.</strong> ${esc(str(b.prospect_mindset))}`, str(b.prospect_mindset).length + 20))
    }
    const options = strArray(b.phrasing_options)
    if (options.length) blocks.push(list(options.map(esc)))
    if (str(b.recommended)) {
      blocks.push(body(`<strong>Recommended.</strong> ${esc(str(b.recommended))}`, str(b.recommended).length + 14))
    }
    blocks.push(divider())
  })

  return { docTitle: frameworkName || 'Your offer script', blocks }
}
