import { chalkFont, coverDataUrl, fontDataUrl, DocType } from './assets'
import { esc } from './html'

// The cover page (page 1). The cover art is a 1632x2176 chalkboard image with two
// painted green labels ("YOUR FRAMEWORK", "PREPARED FOR") baked in. The coach's
// framework title drops into the gap under "YOUR FRAMEWORK" (two balanced lines),
// and their name drops just under "PREPARED FOR". All coordinates below are in
// native stage pixels (the 1632x2176 space the placement was proven in); CSS
// scales the stage by 0.5 onto a Letter page. The engine renders with JavaScript
// disabled, so sizes + the two-line split are computed here (opentype advance
// widths) and baked into inline styles.

// Measured label edges per cover (native px). The title region and name anchor
// are derived from these exactly as the spec fixes them.
const COVERS: Record<DocType, { yfBottom: number; pfTop: number; pfBottom: number }> = {
  framework: { yfBottom: 1291, pfTop: 1683, pfBottom: 1757 },
  guide: { yfBottom: 1190, pfTop: 1683, pfBottom: 1726 },
  script: { yfBottom: 1278, pfTop: 1652, pfBottom: 1689 },
}

const font = () => chalkFont()
const advance = (t: string, s: number) => font().getAdvanceWidth(t, s)
// Line height from the font metrics, matched to the proven placement (x0.90).
const lineH = (s: number) =>
  Math.round(((font().ascender - font().descender) / font().unitsPerEm) * s * 0.9)

// Split a title into the two balanced lines that minimise the width difference.
function balancedSplit(t: string): string[] {
  const w = t.split(/\s+/).filter(Boolean)
  if (w.length < 2) return [t]
  let best: { d: number; lines: [string, string] } | null = null
  for (let i = 1; i < w.length; i++) {
    const a = w.slice(0, i).join(' ')
    const b = w.slice(i).join(' ')
    const d = Math.abs(advance(a, 100) - advance(b, 100))
    if (!best || d < best.d) best = { d, lines: [a, b] }
  }
  return best!.lines
}

// Title = framework name: two balanced lines, largest size from 150 where the
// wider line fits 1300px and two line-heights fit the region. Min 60.
function fitTitle(title: string, regionH: number): { lines: string[]; size: number; lh: number } {
  const lines = balancedSplit(title)
  for (let s = 150; s >= 60; s -= 2) {
    const wmax = Math.max(...lines.map((l) => advance(l, s)))
    if (wmax <= 1300 && lineH(s) * lines.length <= regionH) return { lines, size: s, lh: lineH(s) }
  }
  return { lines, size: 60, lh: lineH(60) }
}

// Name = single line, largest size from 120 that fits 1240px. Min 56. An absurdly
// long name falls back to a balanced two-line split at the min size.
function fitName(name: string): { lines: string[]; size: number; lh: number } {
  for (let s = 120; s >= 56; s -= 2) if (advance(name, s) <= 1240) return { lines: [name], size: s, lh: lineH(s) }
  const lines = balancedSplit(name)
  return { lines, size: 56, lh: lineH(56) }
}

// The @font-face + cover CSS. Emitted once per document (shared with the shell's
// <style>). Kept as its own block so the cover can be built standalone in tests.
export function coverCss(): string {
  return `
@font-face {
  font-family: 'MTM Chalk';
  src: url(${fontDataUrl()}) format('truetype');
}
.cover-page {
  width: 816px; height: 1056px;
  position: relative; overflow: hidden;
  background: #010a1b;
  page-break-after: always;
}
.cover-stage {
  position: absolute; top: 0; left: 0;
  width: 1632px; height: 2176px;
  transform: scale(0.5); transform-origin: top left;
  margin-top: -16px;
}
.cover-bg { position: absolute; top: 0; left: 0; width: 1632px; height: 2176px; }
.cover-slot {
  position: absolute; left: 0; width: 1632px;
  text-align: center; color: #eef0f5;
  font-family: 'MTM Chalk'; margin: 0; padding: 0;
}`
}

// Build the cover page markup for a document. frameworkName fills the title slot,
// coachName the "prepared for" slot; both are the same across a coach's 3 docs.
export function buildCoverPage(doc: DocType, frameworkName: string, coachName: string): string {
  const c = COVERS[doc]
  const regionTop = c.yfBottom + 40
  const regionH = c.pfTop - 52 - regionTop
  const nameTop = c.pfBottom + 24

  const title = fitTitle((frameworkName || 'Your Framework').trim(), regionH)
  const name = fitName((coachName || '').trim())

  const titleHtml = title.lines.map(esc).join('<br>')
  const nameHtml = name.lines.map(esc).join('<br>')

  return `<section class="cover-page">
  <div class="cover-stage">
    <img class="cover-bg" src="${coverDataUrl(doc)}">
    <div class="cover-slot"
         style="top:${regionTop}px; height:${regionH}px;
                display:flex; flex-direction:column; justify-content:center;
                font-size:${title.size}px; line-height:${title.lh}px;">${titleHtml}</div>
    <div class="cover-slot"
         style="top:${nameTop}px; font-size:${name.size}px; line-height:${name.lh}px;">${nameHtml}</div>
  </div>
</section>`
}

// Exposed for unit testing the fit math without building full markup.
export const _fit = { balancedSplit, fitTitle, fitName, COVERS }
