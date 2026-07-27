import { chalkFont, coverDataUrl, fontDataUrl, DocType } from './assets'
import { esc } from './html'

// The cover page (page 1). The cover art is a 1632x2176 chalkboard image with two
// painted green labels ("YOUR FRAMEWORK", "PREPARED FOR") baked in. The coach's
// framework title drops into the gap under "YOUR FRAMEWORK" (two balanced lines),
// and their name drops just under "PREPARED FOR". All coordinates below are in
// native stage pixels (the 1632x2176 space the placement was proven in); they are
// pre-scaled by 0.5 into Letter page px at emit time (buildCoverPage), with NO CSS
// transform — a scale() transform makes headless Chromium drop the cover text in a
// multi-page print doc. The engine renders with JavaScript disabled, so sizes +
// the two-line split are computed here (opentype advance widths) and baked into
// inline styles.

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
  font-display: swap;
}
.cover-page {
  width: 816px; height: 1056px;
  position: relative; overflow: hidden;
  background: #010a1b;
  page-break-after: always;
}
.cover-bg { position: absolute; left: 0; top: -16px; width: 816px; height: 1088px; }
.cover-slot {
  position: absolute; left: 0; width: 816px;
  text-align: center; color: #eef0f5;
  font-family: 'MTM Chalk', 'Segoe UI', Helvetica, Arial, sans-serif; margin: 0; padding: 0;
}`
}

// Build the cover page markup for a document. frameworkName fills the title slot,
// coachName the "prepared for" slot; both are the same across a coach's 3 docs.
export function buildCoverPage(doc: DocType, frameworkName: string, coachName: string): string {
  const c = COVERS[doc]
  const regionTop = c.yfBottom + 40
  const regionH = c.pfTop - 52 - regionTop
  const nameTop = c.pfBottom + 24

  // Fit math stays in native (1632x2176) px so the proven placement is unchanged.
  const title = fitTitle((frameworkName || 'Your Framework').trim(), regionH)
  const name = fitName((coachName || '').trim())

  const titleHtml = title.lines.map(esc).join('<br>')
  const nameHtml = name.lines.map(esc).join('<br>')

  // Emit page-space px (native x 0.5) with NO CSS transform: headless Chromium
  // drops transformed *text* (while still painting the transformed image) in
  // multi-page print output, which blanked the cover slots in the full document.
  // `top()` also folds the -16px image offset (the 32px-native empty-margin crop)
  // into each slot's top; `px()` scales sizes/heights.
  const K = 0.5
  const top = (nativeY: number) => (nativeY * K - 16).toFixed(1)
  const px = (nativeV: number) => (nativeV * K).toFixed(1)

  return `<section class="cover-page">
  <img class="cover-bg" src="${coverDataUrl(doc)}">
  <div class="cover-slot"
       style="top:${top(regionTop)}px; height:${px(regionH)}px;
              display:flex; flex-direction:column; justify-content:center;
              font-size:${px(title.size)}px; line-height:${px(title.lh)}px;">${titleHtml}</div>
  <div class="cover-slot"
       style="top:${top(nameTop)}px; font-size:${px(name.size)}px; line-height:${px(name.lh)}px;">${nameHtml}</div>
</section>`
}

// Exposed for unit testing the fit math without building full markup.
export const _fit = { balancedSplit, fitTitle, fitName, COVERS }
