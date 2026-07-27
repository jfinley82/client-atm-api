import { esc, str, strArray } from './html'

// The lead-magnet Guide — a coach-branded workbook PDF, ported from
// claude/guide-pdf-mockup.html. HARD RULE: zero MTM branding. Everything on the
// page is the coach's — business name, accent color, booking link. This module
// is self-contained (its own <head>/CSS, cover, interior, and close) and does NOT
// reuse the framework cover/shell (which carry MTM chalkboard art). It emits a
// complete print-ready document for POST /api/pdf/render.
//
// The mockup is authored on a 660x854 on-screen page; the PDF renders a Letter
// sheet, so every dimension is scaled by S (816/660) into 816x1056 page space.

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})

// ── Brand tokens ──────────────────────────────────────────────────────────────
export type GuideBrand = {
  businessName: string // cover, running header/footer
  presenterName: string // "A workbook by {presenterName}", personal note
  accent: string // validated hex (#rgb or #rrggbb); caller applies the neutral-slate fallback
  bookingUrl: string // full href — never shown as bare text
  bookingDisplay: string // host shown in the CTA meta/footer (no protocol)
  trainingUrl?: string // funnel training page for the companion callout; '' when no funnel
}

// ── accent shade derivation ─────────────────────────────────────────────────
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
// Blend `rgb` toward `target` by t (0..1).
function blend(rgb: [number, number, number], target: [number, number, number], t: number): [number, number, number] {
  return [rgb[0] + (target[0] - rgb[0]) * t, rgb[1] + (target[1] - rgb[1]) * t, rgb[2] + (target[2] - rgb[2]) * t]
}
const WHITE: [number, number, number] = [255, 255, 255]
const BLACK: [number, number, number] = [0, 0, 0]
const NEUTRAL_SLATE = '#334155'

// From the accent, derive: soft (~8% tint for panels), ink (darkened for text on
// tint), and a border (~22% tint) replacing the mockup's hard-coded #cfe6e2.
export function accentShades(accentHex: string): { accent: string; soft: string; ink: string; border: string } {
  const rgb = parseHex(accentHex) || parseHex(NEUTRAL_SLATE)!
  const accent = toHex(rgb[0], rgb[1], rgb[2])
  const soft = toHex(...blend(WHITE, rgb, 0.08))
  const ink = toHex(...blend(rgb, BLACK, 0.3))
  const border = toHex(...blend(WHITE, rgb, 0.22))
  return { accent, soft, ink, border }
}

// Strip a leading debug/version tag like "REBUILD5:" from coach-entered proof
// before it reaches the lead-facing page. Only fires on an all-caps token that
// CONTAINS a digit followed by a colon — normal prose ("Note:", "In 2023,") is
// left untouched.
export function stripDebugPrefix(s: string): string {
  return String(s || '').replace(/^\s*[A-Z][A-Z0-9]*\d[A-Z0-9]*\s*:\s+/, '')
}

// ── layout scale (mockup 660px page → 816px Letter page) ────────────────────
const S = 816 / 660
const px = (n: number): string => (n * S).toFixed(1) + 'px'
const CONTENT_W = 816 - 74 * 2 // page minus horizontal padding
// Usable content height per interior page (1056 - body-pad top 60 - footer zone
// ~62). Calibrated against measured render heights so a page fills like the
// mockup (e.g. three short exercises share one page) without clipping the footer.
const PAGE_BUDGET = 1056 - 60 - 66

// ── CSS (ported verbatim from the mockup, values scaled by S) ────────────────
function guideCss(sh: { accent: string; soft: string; ink: string; border: string }): string {
  return `
@page { size: Letter; margin: 0; }
*{ box-sizing:border-box; margin:0; padding:0; }
html,body{ margin:0; padding:0; }
:root{ --accent:${sh.accent}; --accent-soft:${sh.soft}; --accent-ink:${sh.ink}; --accent-border:${sh.border};
  --ink:#1a2230; --muted:#6b7280; --line:#e5e7eb; }
body{ font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--ink); }
.page{ width:816px; height:1056px; background:#fff; position:relative; overflow:hidden; page-break-after:always; }
.page:last-child{ page-break-after:auto; }
.pg-pad{ padding:${px(56)} ${px(60)}; position:absolute; top:0; left:0; right:0; }
.pg-pad.body-pad{ padding-top:60px; }

.rhead{ position:absolute; top:${px(26)}; left:${px(60)}; right:${px(60)}; display:flex; align-items:center; justify-content:space-between; font-size:${px(10)}; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
.rhead .b{ color:var(--accent-ink); }
.rfoot{ position:absolute; bottom:${px(26)}; left:${px(60)}; right:${px(60)}; display:flex; align-items:center; justify-content:space-between; font-size:${px(10)}; color:var(--muted); border-top:1px solid var(--line); padding-top:${px(10)}; }
.rfoot .b{ font-weight:700; color:var(--ink); }

.sec{ display:flex; align-items:center; gap:${px(12)}; margin-bottom:${px(18)}; }
.sec .num{ width:${px(30)}; height:${px(30)}; border-radius:${px(8)}; background:var(--accent); color:#fff; font-weight:800; font-size:${px(14)}; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
.sec .t{ font-size:${px(19)}; font-weight:800; color:var(--ink); letter-spacing:-.01em; }
.kicker{ font-size:${px(11)}; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); margin-bottom:${px(7)}; }

p.body{ font-size:${px(13.5)}; line-height:1.72; color:#374151; margin-bottom:${px(13)}; }
p.body.lg{ font-size:${px(14.5)}; }
p.sig{ font-size:${px(14)}; font-weight:700; color:var(--accent-ink); margin-top:${px(10)}; }

.callout{ background:var(--accent-soft); border:1px solid var(--accent-border); border-left:${px(4)} solid var(--accent); border-radius:${px(10)}; padding:${px(16)} ${px(18)}; margin:${px(18)} 0; }
.callout h4{ font-size:${px(11)}; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--accent-ink); margin-bottom:${px(10)}; }
.callout ul{ margin:0; padding-left:${px(18)}; }
.callout li{ font-size:${px(13)}; line-height:1.6; color:#334155; margin-bottom:${px(7)}; }
.callout li b{ color:var(--accent-ink); }
.callout p{ font-size:${px(13)}; line-height:1.62; color:#334155; margin:0; }

/* companion-to-the-training callout (top of the first content page) */
.companion{ display:flex; align-items:center; gap:${px(16)}; background:var(--accent-soft); border:1px solid var(--accent-border); border-left:${px(4)} solid var(--accent); border-radius:${px(10)}; padding:${px(14)} ${px(16)}; margin:0 0 ${px(20)}; }
.companion .left{ flex:1; }
.companion .cl{ font-size:${px(10)}; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--accent-ink); margin-bottom:${px(5)}; }
.companion .ct{ font-size:${px(12.5)}; line-height:1.5; color:#334155; margin-bottom:${px(8)}; }
.companion .clink{ font-size:${px(12.5)}; font-weight:800; color:var(--accent-ink); text-decoration:none; }
.companion .cqr{ flex:0 0 auto; text-align:center; }
.companion .cqr img{ width:${px(62)}; height:${px(62)}; display:block; background:#fff; border-radius:${px(6)}; }
.companion .cqr span{ display:block; font-size:${px(8)}; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--accent-ink); margin-top:${px(3)}; }

/* cover — no height override: the .page fixed 1056px height must win so the flex
   column fills the sheet and .bot sits at the bottom (a same-element height:100%
   would resolve against <body> auto and collapse the cover to content height). */
.cover{ display:flex; flex-direction:column; }
.cover .band{ position:absolute; top:0; right:0; width:${px(210)}; height:100%; background:linear-gradient(160deg,var(--accent) 0%,var(--accent-ink) 100%); opacity:.06; }
.cover .top{ padding:${px(56)} ${px(60)} 0; }
.cover .biz{ font-size:${px(12)}; font-weight:800; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); }
.cover .mid{ flex:1; padding:0 ${px(60)}; display:flex; flex-direction:column; justify-content:center; }
.cover .eyebrow{ font-size:${px(12)}; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:${px(16)}; }
.cover h1{ font-size:${px(42)}; line-height:1.08; font-weight:800; letter-spacing:-.02em; color:var(--ink); }
.cover .sub{ font-size:${px(16)}; color:var(--muted); margin-top:${px(16)}; line-height:1.5; max-width:${px(440)}; }
.cover .accentbar{ height:${px(8)}; width:${px(120)}; background:var(--accent); border-radius:${px(4)}; margin-top:${px(30)}; }
.cover .bot{ padding:0 ${px(60)} ${px(52)}; display:flex; align-items:flex-end; justify-content:space-between; }
.cover .bot .by{ font-size:${px(12.5)}; color:var(--muted); line-height:1.5; }
.cover .bot .by b{ color:var(--ink); font-weight:700; }
.cover .tag{ font-size:${px(11)}; font-weight:800; color:var(--accent-ink); background:var(--accent-soft); border:1px solid var(--accent-border); border-radius:999px; padding:${px(5)} ${px(12)}; }

/* exercises */
.ex{ border:1px solid var(--line); border-radius:${px(12)}; padding:${px(16)} ${px(18)} ${px(14)}; margin-bottom:${px(16)}; }
.ex .q{ display:flex; gap:${px(11)}; margin-bottom:${px(6)}; }
.ex .qn{ width:${px(26)}; height:${px(26)}; border-radius:${px(7)}; border:2px solid var(--accent); color:var(--accent-ink); font-weight:800; font-size:${px(13)}; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
.ex .qt{ font-size:${px(13.5)}; font-weight:700; color:var(--ink); line-height:1.5; }
.ex .rev{ font-size:${px(11)}; color:var(--muted); margin:${px(2)} 0 ${px(12)} ${px(37)}; }
.ex .rev b{ color:var(--accent-ink); font-weight:700; }
.lines{ margin-left:${px(37)}; }
.lines .ln{ height:${px(24)}; border-bottom:1px solid #dfe3ea; }
.lines .ln:last-child{ border-bottom:1px dashed #dfe3ea; }

/* close / CTA */
.cta-page{ display:flex; flex-direction:column; height:100%; justify-content:flex-start; padding:${px(52)} ${px(60)}; }
.cta-kick{ font-size:${px(12)}; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); }
.cta-h{ font-size:${px(32)}; font-weight:800; letter-spacing:-.02em; color:var(--ink); margin:${px(12)} 0 ${px(18)}; line-height:1.12; }
.trans{ display:flex; align-items:stretch; margin:${px(16)} 0 ${px(4)}; }
.trans .col{ flex:1; border-radius:${px(12)}; padding:${px(15)} ${px(16)}; }
.trans .from{ background:#f6f7f9; border:1px solid var(--line); }
.trans .to{ background:var(--accent-soft); border:1px solid var(--accent-border); }
.trans .lab{ font-size:${px(10)}; font-weight:800; letter-spacing:.1em; text-transform:uppercase; margin-bottom:${px(8)}; }
.trans .from .lab{ color:var(--muted); }
.trans .to .lab{ color:var(--accent-ink); }
.trans .col p{ font-size:${px(12)}; line-height:1.55; color:#374151; margin:0; }
.trans .arrow{ display:flex; align-items:center; justify-content:center; width:${px(36)}; flex:0 0 auto; }
.trans .arrow svg{ width:${px(22)}; height:${px(22)}; stroke:var(--accent); fill:none; stroke-width:2.6; }
.bridge{ font-size:${px(13)}; line-height:1.6; color:var(--ink); font-weight:600; margin:${px(16)} 0 ${px(6)}; }
.bridge b{ color:var(--accent-ink); }
.proofline{ font-size:${px(11.5)}; line-height:1.5; color:var(--muted); font-style:italic; margin:0 0 ${px(16)}; }
.proofline b{ color:var(--accent-ink); font-style:normal; }
.ctabox2{ display:flex; gap:${px(18)}; background:var(--accent); border-radius:${px(14)}; padding:${px(20)} ${px(22)}; color:#fff; align-items:center; }
.ctabox2 .left{ flex:1; }
.ctabox2 .cl{ font-size:${px(11)}; font-weight:800; letter-spacing:.1em; text-transform:uppercase; opacity:.85; }
.ctabox2 .h2{ font-size:${px(19)}; font-weight:800; margin:${px(7)} 0 ${px(13)}; }
.btn2{ display:inline-block; background:#fff; color:var(--accent-ink); font-weight:800; font-size:${px(13.5)}; padding:${px(11)} ${px(20)}; border-radius:${px(10)}; }
.ctabox2 .meta{ font-size:${px(11.5)}; opacity:.9; margin-top:${px(11)}; }
.qrwrap{ background:#fff; border-radius:${px(12)}; padding:${px(9)} ${px(9)} ${px(6)}; text-align:center; flex:0 0 auto; }
.qrwrap img{ width:${px(92)}; height:${px(92)}; display:block; }
.qrwrap span{ display:block; font-size:${px(9)}; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--accent-ink); margin-top:${px(4)}; }
.pnote{ font-size:${px(12)}; line-height:1.6; color:#4b5563; font-style:italic; margin-top:${px(16)}; }
.cta-foot{ margin-top:auto; padding-top:${px(26)}; border-top:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; font-size:${px(11)}; color:var(--muted); }
.cta-foot b{ color:var(--ink); }`
}

// ── height estimates (render runs no JS; conservative — rather short than clip) ─
const wraps = (text: string, fontPx: number, width = CONTENT_W): number =>
  Math.max(1, Math.ceil(((text || '').length * fontPx * 0.52) / width))
const paraH = (text: string, lg = false): number => {
  const f = (lg ? 14.5 : 13.5) * S
  return wraps(text, f) * f * 1.72 + 13 * S
}
const calloutH = (items: string[]): number =>
  (16 + 10 + 7) * S + 22 * S + items.reduce((n, it) => n + wraps(it, 13 * S, CONTENT_W - 18 * S) * 13 * S * 1.6 + 7 * S, 0)
const secH = (title: string): number => (11 + 7) * S + Math.max(30 * S, wraps(title, 19 * S) * 19 * S * 1.1) + 18 * S
function exH(prompt: string, reveal: string, lines: number): number {
  const qt = wraps(prompt, 13.5 * S, CONTENT_W - 37 * S) * 13.5 * S * 1.5
  const rev = wraps(reveal, 11 * S, CONTENT_W - 37 * S) * 11 * S * 1.5
  // padding(16+14) + q-margin(6) + rev-margin(~12) + block margin-bottom(16), all ×S.
  return (16 + 6 + 12 + 14 + 16) * S + Math.max(24 * S, qt) + rev + lines * 24 * S
}

// ── page frame ───────────────────────────────────────────────────────────────
function pageFrame(brand: GuideBrand, sectionLabel: string, pageNo: number, innerHtml: string): string {
  return `<section class="page">
  <div class="rhead"><span class="b">${esc(brand.businessName)}</span><span>${esc(sectionLabel)}</span></div>
  <div class="pg-pad body-pad">${innerHtml}</div>
  <div class="rfoot"><span class="b">${esc(brand.businessName)}</span><span>${pageNo}</span></div>
</section>`
}

type Blk = { html: string; h: number }

// Pack a chapter's blocks into as many pages as needed, each with the running
// header/footer, so long content never clips. Returns pages + the next page no.
function packChapter(brand: GuideBrand, sectionLabel: string, header: string, headerH: number, blocks: Blk[], startPage: number): { pages: string[]; nextPage: number } {
  const pages: string[] = []
  let cur: string[] = [header]
  let used = headerH
  let page = startPage
  const flush = () => {
    pages.push(pageFrame(brand, sectionLabel, page, cur.join('')))
    page++
    cur = []
    used = 0
  }
  for (const b of blocks) {
    if (cur.length > 0 && used + b.h > PAGE_BUDGET) flush()
    cur.push(b.html)
    used += b.h
  }
  if (cur.length > 0) flush()
  return { pages, nextPage: page }
}

// ── the document ─────────────────────────────────────────────────────────────
export function buildGuideDocument(opts: {
  brand: GuideBrand
  workbook: unknown
  delivery: unknown
  // Clean, lead-facing SECOND-PERSON copy (generated + persisted by lib/guideCopy).
  // The guide NEVER derives close copy from the third-person avatar states here.
  transformationClose: { before: string; after: string; bridge: string }
  recap: { started: string; did: string; first_part: string; stick: string }
  frameworkName: string
  coverTitle?: string
  qrDataUri: string | null
  trainingQrDataUri?: string | null
}): string {
  const { brand } = opts
  const sh = accentShades(brand.accent)
  const w = obj(opts.workbook)
  const d = obj(opts.delivery)

  // paragraphs split on blank lines (problem_intro / understanding are authored
  // as short blank-line-separated paragraphs).
  const paras = (v: unknown): string[] =>
    str(v).split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)

  // ── COVER ──
  const coverTitle = str(opts.coverTitle) || str(w.title) || str(opts.frameworkName) || 'Your workbook'
  const coverSub = str(w.subtitle) || 'Your path to the transformation.'
  const cover = `<section class="page cover">
  <div class="band"></div>
  <div class="top"><div class="biz">${esc(brand.businessName)}</div></div>
  <div class="mid">
    <div class="eyebrow">A workbook · solve one problem</div>
    <h1>${esc(coverTitle)}</h1>
    <div class="sub">${esc(coverSub)}</div>
    <div class="accentbar"></div>
  </div>
  <div class="bot">
    <div class="by">A workbook by <b>${esc(brand.presenterName)}</b><br>${esc(brand.businessName)}</div>
    <span class="tag">15-minute companion</span>
  </div>
</section>`

  // ── PROBLEM CHAPTER (page 2+) ──
  const sections = Array.isArray(w.sections) ? w.sections.map(obj) : []
  const problemTitle = str(sections[0]?.sectionTitle) || 'Where you are right now'
  const problemHeader =
    `<div class="kicker">Start here</div>` +
    `<div class="sec"><span class="num">1</span><span class="t">${esc(problemTitle)}</span></div>`
  const problemHeaderH = secH(problemTitle)
  const problemBlocks: Blk[] = []
  // Companion-to-the-training callout (accent) — tells the lead this workbook goes
  // with the coach's training and links/QRs them to watch it. Only when the coach
  // has a funnel training page.
  if (brand.trainingUrl) {
    const cqr = opts.trainingQrDataUri
      ? `<div class="cqr"><img src="${opts.trainingQrDataUri}" alt="Scan to watch"><span>Scan to watch</span></div>`
      : ''
    problemBlocks.push({
      html:
        `<div class="companion"><div class="left">` +
        `<div class="cl">Your companion to the training</div>` +
        `<div class="ct">This workbook goes with ${esc(brand.businessName)}&rsquo;s training. Haven&rsquo;t watched it yet? Start there &mdash; then work through these pages.</div>` +
        `<a class="clink" href="${esc(brand.trainingUrl)}" target="_blank">Watch the training &rarr;</a>` +
        `</div>${cqr}</div>`,
      h: 150,
    })
  }
  paras(w.problem_intro).forEach((p, i) => problemBlocks.push({ html: `<p class="body${i === 0 ? ' lg' : ''}">${esc(p)}</p>`, h: paraH(p, i === 0) }))
  paras(w.understanding).forEach((p) => problemBlocks.push({ html: `<p class="body">${esc(p)}</p>`, h: paraH(p) }))
  const takeaways = strArray(w.keyTakeaways).slice(0, 3)
  if (takeaways.length) {
    problemBlocks.push({
      html: `<div class="callout"><h4>What you'll walk away with</h4><ul>${takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`,
      h: calloutH(takeaways),
    })
  }
  const problem = packChapter(brand, problemTitle, problemHeader, problemHeaderH, problemBlocks, 2)

  // ── EXERCISE CHAPTER ── the coach's selected (recommended) configurable
  // questions, max 2 per phase/section, flattened and numbered sequentially.
  const exercises: { prompt: string; reveal: string; lines: number }[] = []
  for (const s of sections) {
    const list = (Array.isArray(s.exercises) ? s.exercises.map(obj) : [])
      .filter((e) => str(e.prompt))
      .filter((e) => e.recommended !== false)
      .slice(0, 3) // up to 3 selected questions per phase
    for (const e of list) {
      exercises.push({ prompt: str(e.prompt), reveal: str(e.collects) || str(e.why_fits), lines: Math.min(4, Math.max(2, Number(e.lines) || 3)) })
    }
  }
  const exercisePages: string[] = []
  let afterExercisesPage = problem.nextPage
  if (exercises.length) {
    const exTitle = 'Work it through'
    const exHeader =
      `<div class="kicker">Do the work</div>` +
      `<div class="sec"><span class="num">2</span><span class="t">${esc(exTitle)}</span></div>` +
      `<p class="body" style="margin-bottom:${px(20)}">Take these one at a time. Writing it down by hand is what makes the pattern concrete.</p>`
    const exHeaderH = secH(exTitle) + paraH('Take these one at a time. Writing it down by hand is what makes the pattern concrete.') + 8 * S
    const exBlocks: Blk[] = exercises.map((e, i) => ({
      html:
        `<div class="ex"><div class="q"><span class="qn">${i + 1}</span><span class="qt">${esc(e.prompt)}</span></div>` +
        (e.reveal ? `<div class="rev"><b>What this reveals:</b> ${esc(e.reveal)}</div>` : '') +
        `<div class="lines">${Array.from({ length: e.lines }, () => '<div class="ln"></div>').join('')}</div></div>`,
      h: exH(e.prompt, e.reveal, e.lines),
    }))
    const ex = packChapter(brand, 'Your exercises', exHeader, exHeaderH, exBlocks, problem.nextPage)
    exercisePages.push(...ex.pages)
    afterExercisesPage = ex.nextPage
  }

  // ── RECAP ── a PERSONAL LETTER from the coach, after the exercises and before
  // the close: leads with where they started when they opened the guide, names
  // what they did, reminds them this is only the first part, and gets personal
  // about how it was vs. what it could be if they stick with it — then is signed.
  // Prefers the generated workbook.recap; falls back to composing from the
  // before/after states for guides generated before the recap field existed.
  const recapPages: string[] = []
  {
    const rc = opts.recap
    const firstName = brand.presenterName.split(/\s+/)[0] || brand.presenterName

    // opts.recap is clean, generated second-person copy. The fallbacks fire only if
    // generation failed — clean generic lines, never avatar text.
    const started =
      str(rc.started) ||
      'When you opened this guide, something was not adding up — you were showing up and doing the work, and still not seeing it come back the way it should.'
    const did =
      str(rc.did) ||
      'In these pages, you stopped guessing. You looked honestly at where the pattern actually shows up — in your own words, your own numbers. That is the part most people skip.'
    const firstPart =
      str(rc.first_part) ||
      'This guide is only the first part. It names the pattern and starts the shift. It does not finish it — and it was never meant to.'
    const stick =
      str(rc.stick) ||
      'It does not have to stay the way it has felt. The shift you just started to see is the one that changes it — if you stick with it.'

    const recapChip = exercises.length ? 3 : 2
    const recapTitle = 'Before you go'
    const recapHeader =
      `<div class="kicker">A note from ${esc(firstName)}</div>` +
      `<div class="sec"><span class="num">${recapChip}</span><span class="t">${esc(recapTitle)}</span></div>`
    const recapHeaderH = secH(recapTitle)

    const letter = [
      { t: started, lg: true },
      { t: did, lg: false },
      { t: firstPart, lg: false },
      { t: stick, lg: false },
    ]
    const recapBlocks: Blk[] = letter.map((p) => ({ html: `<p class="body${p.lg ? ' lg' : ''}">${esc(p.t)}</p>`, h: paraH(p.t, p.lg) }))
    recapBlocks.push({ html: `<p class="sig">— ${esc(brand.presenterName)}</p>`, h: 30 * S })

    const recap = packChapter(brand, 'Before you go', recapHeader, recapHeaderH, recapBlocks, afterExercisesPage)
    recapPages.push(...recap.pages)
  }

  // ── CLOSE (the priority) ── clean second person from opts.transformationClose;
  // never the third-person avatar states. Fallbacks are clean generic lines.
  const tc = opts.transformationClose
  const before = str(tc.before) || 'Right now, the people who value your work most are not the ones paying you for it — and it is quietly wearing on you.'
  const after = str(tc.after) || 'That changes when the way you are positioned finally matches the value you already deliver — and the right people say yes without being convinced.'
  const bridgeText = str(tc.bridge) || "Closing that gap comes down to how you're positioned and how your sales conversation goes — and that's the work we'd do together on one call."
  const proof = stripDebugPrefix(str(obj(d.personal_hook).proof))
  const ctaType = d.cta_type === 'sell_program' ? 'sell_program' : 'book_call'
  const ctaLabel = ctaType === 'sell_program' ? 'See the program' : 'Book your call'
  const ctaHeading = ctaType === 'sell_program' ? 'Take the next step' : 'Book your call'
  const ARROW = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'

  const transHtml = `<div class="trans">
      <div class="col from"><div class="lab">Where you are now</div><p>${esc(before)}</p></div>
      <div class="arrow">${ARROW}</div>
      <div class="col to"><div class="lab">Where this goes</div><p>${esc(after)}</p></div>
    </div>`
  const bridge = `<div class="bridge">${esc(bridgeText)}</div>`
  const proofLine = proof ? `<div class="proofline"><b>Real result:</b> ${esc(proof)}</div>` : ''
  const qrHtml = opts.qrDataUri
    ? `<div class="qrwrap"><img src="${opts.qrDataUri}" alt="Scan to book"><span>Scan to book</span></div>`
    : ''
  const personalNote = `<div class="pnote">${esc(`"If the first picture sounded like your last few months, the second one is closer than it feels. Let's map it on a call."`)} — ${esc(brand.presenterName)}</div>`

  const close = `<section class="page">
  <div class="cta-page">
    <div class="cta-kick">Where this goes</div>
    <div class="cta-h">You're closer to this than it feels</div>
    ${transHtml}
    ${bridge}
    ${proofLine}
    <div class="ctabox2">
      <div class="left">
        <div class="cl">Your next step</div>
        <div class="h2">${esc(ctaHeading)}</div>
        <a class="btn2" href="${esc(brand.bookingUrl)}">${esc(ctaLabel)} &rarr;</a>
        <div class="meta">Free · about 30 minutes · ${esc(brand.bookingDisplay)}</div>
      </div>
      ${qrHtml}
    </div>
    ${personalNote}
    <div class="cta-foot"><span>A workbook by <b>${esc(brand.businessName)}</b></span><span>${esc(brand.bookingDisplay)}</span></div>
  </div>
</section>`

  return `<!doctype html><html><head><meta charset="utf-8"><style>${guideCss(sh)}</style></head><body>
${cover}
${problem.pages.join('\n')}
${exercisePages.join('\n')}
${recapPages.join('\n')}
${close}
</body></html>`
}

export const NEUTRAL_ACCENT = NEUTRAL_SLATE
