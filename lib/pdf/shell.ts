import { esc } from './html'
import { coverCss } from './cover'

// The interior shell (pages 2..N): the locked light-editorial frame shared by all
// three documents — running header, running footer with the domain + page number,
// and one set of section / list / callout / stat styles. Single column, page
// width, print-built. Tokens + rules are carried verbatim from the approved look.

export const INTERIOR_CSS = `
:root{
  --navy:#020c31; --navy2:#0a1746; --green:#6dd80e; --green-ink:#3f7d09;
  --ink:#1b2238; --muted:#727a90; --line:#e7eaf1; --tint:#f2fbe6; --paper:#ffffff;
}
.page{ width:816px; height:1056px; background:var(--paper); position:relative;
  overflow:hidden; page-break-after:always; }
.content{ padding:64px 72px 68px; display:flex; flex-direction:column; height:100%; }
.rhead{ display:flex; justify-content:space-between; align-items:center;
  padding-bottom:12px; border-bottom:1px solid var(--line); margin-bottom:34px; }
.rhead .mark{ display:flex; align-items:center; gap:8px; font-weight:800; color:var(--navy);
  font-size:12px; letter-spacing:.06em; }
.rhead .mark .dot{ width:16px; height:16px; border-radius:50%; background:var(--green);
  color:var(--navy); font-size:8px; font-weight:900; display:inline-flex;
  align-items:center; justify-content:center; }
.rhead .doc{ color:var(--muted); font-size:11px; letter-spacing:.16em;
  text-transform:uppercase; font-weight:700; }
.kicker{ color:var(--green-ink); font-weight:800; letter-spacing:.16em; font-size:11px;
  text-transform:uppercase; margin-bottom:9px; }
h2.section{ font-size:27px; font-weight:800; letter-spacing:-.02em; color:var(--navy); line-height:1.1; }
.lead{ font-size:15px; line-height:1.6; color:#3a4260; margin-top:14px; font-weight:500; }
h3.sub{ font-size:16px; font-weight:800; color:var(--navy); margin:30px 0 10px; }
p.body{ font-size:13px; line-height:1.7; color:var(--ink); margin-bottom:12px; }
p.body strong{ color:var(--navy); }
ul.list{ list-style:none; margin:8px 0 4px; }
ul.list li{ position:relative; padding-left:22px; font-size:13px; line-height:1.6;
  color:var(--ink); margin-bottom:10px; }
ul.list li::before{ content:""; position:absolute; left:2px; top:7px; width:7px; height:7px;
  border-radius:2px; background:var(--green); }
ul.list li b{ color:var(--navy); }
.callout{ background:var(--tint); border-left:4px solid var(--green); border-radius:0 8px 8px 0;
  padding:16px 20px; margin:16px 0; }
.callout .q{ font-size:14px; line-height:1.55; color:var(--navy); font-weight:600; font-style:italic; }
.callout .cite{ margin-top:8px; font-size:11px; color:var(--muted); font-weight:600; }
.twoup{ display:flex; gap:18px; margin:16px 0; }
.twoup .box{ flex:1; border:1px solid var(--line); border-radius:10px; padding:16px 18px; background:#fbfcfe; }
.twoup .box.win{ border-color:#cdeeb0; background:var(--tint); }
.twoup .box h4{ font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase;
  color:var(--muted); margin-bottom:10px; }
.twoup .box.win h4{ color:var(--green-ink); }
.twoup .box p{ font-size:12.5px; line-height:1.55; color:var(--ink); }
.stats{ display:flex; gap:16px; margin:18px 0; }
.stat{ flex:1; border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
.stat .lab{ font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.stat .val{ font-size:30px; font-weight:900; letter-spacing:-.03em; color:var(--navy); margin-top:6px; line-height:1; }
.stat .val.g{ color:var(--green-ink); }
.divider{ height:1px; background:var(--line); margin:26px 0; }
.spacer{ flex:1; }
.rfoot{ display:flex; justify-content:space-between; align-items:center; padding-top:12px;
  border-top:1px solid var(--line); color:var(--muted); font-size:10.5px; letter-spacing:.08em; }
.rfoot .brand{ font-weight:800; color:var(--navy); letter-spacing:.14em; text-transform:uppercase; }
.rfoot .dom{ color:var(--green-ink); font-weight:700; letter-spacing:.06em; }`

// A page-flowable unit. `h` is an estimated rendered height (px); blocks are
// packed into fixed-height pages by that estimate (the render page runs no JS, so
// heights cannot be measured live). Estimates are deliberately conservative — we
// would rather leave a page slightly short than clip a block.
// `keepNext` marks a heading that must not be the last block on a page — the
// paginator keeps it with the block that follows (avoids orphaned headings).
export type Block = { html: string; h: number; keepNext?: boolean }

const CONTENT_W = 672 // 816 - 72*2
// Usable vertical space for content on a page: 1056 - padding(64+68) - header(~62) - footer(~40).
const PAGE_BUDGET = 820

// Rough wrapped-line count for a run of text at a given font size.
function wraps(text: string, fontPx: number, width = CONTENT_W, ratio = 0.53): number {
  const w = Math.max(1, Math.ceil((text.length * fontPx * ratio) / width))
  return w
}

// ── section-vocabulary renderers (each returns a Block) ──────────────────────
export function sectionHead(kicker: string, title: string, lead?: string): Block {
  let h = 0
  let html = ''
  if (kicker) { html += `<div class="kicker">${esc(kicker)}</div>`; h += 20 + 9 }
  html += `<h2 class="section">${esc(title)}</h2>`; h += wraps(title, 27, CONTENT_W, 0.56) * 30
  if (lead) { html += `<p class="lead">${esc(lead)}</p>`; h += 14 + wraps(lead, 15) * 24 }
  return { html, h: h + 8, keepNext: true }
}

export function sub(text: string): Block {
  return { html: `<h3 class="sub">${esc(text)}</h3>`, h: 30 + 10 + wraps(text, 16) * 18, keepNext: true }
}

// body() takes ready HTML (the builder composes <strong>/<b> around escaped text).
export function body(innerHtml: string, textLen: number): Block {
  return { html: `<p class="body">${innerHtml}</p>`, h: wraps('x'.repeat(textLen), 13) * 22 + 12 }
}

export function list(items: string[]): Block {
  // items are ready HTML (<b>..</b> allowed); estimate each item's wrapped height.
  const lis = items.map((it) => `<li>${it}</li>`).join('')
  const h = items.reduce((acc, it) => acc + wraps(it.replace(/<[^>]+>/g, ''), 13, CONTENT_W - 22) * 21 + 10, 0)
  return { html: `<ul class="list">${lis}</ul>`, h: h + 12 }
}

export function callout(quote: string, cite?: string): Block {
  const c = cite ? `<div class="cite">${esc(cite)}</div>` : ''
  const h = 32 + wraps(quote, 14) * 22 + (cite ? 8 + 16 : 0) + 32
  return { html: `<div class="callout"><div class="q">${esc(quote)}</div>${c}</div>`, h }
}

export function twoup(
  left: { h4: string; body: string },
  right: { h4: string; body: string; win?: boolean }
): Block {
  const h = 32 + 10 + Math.max(wraps(left.body, 12.5), wraps(right.body, 12.5)) * 20 + 32 + 16
  return {
    html: `<div class="twoup">
  <div class="box"><h4>${esc(left.h4)}</h4><p>${esc(left.body)}</p></div>
  <div class="box${right.win ? ' win' : ''}"><h4>${esc(right.h4)}</h4><p>${esc(right.body)}</p></div>
</div>`,
    h,
  }
}

export function stats(items: { lab: string; val: string; green?: boolean }[]): Block {
  const boxes = items
    .map((s) => `<div class="stat"><div class="lab">${esc(s.lab)}</div><div class="val${s.green ? ' g' : ''}">${esc(s.val)}</div></div>`)
    .join('')
  return { html: `<div class="stats">${boxes}</div>`, h: 78 + 18 }
}

export function divider(): Block {
  return { html: `<div class="divider"></div>`, h: 53 }
}

// Pack blocks into fixed-height .page sections, repeating the running header and
// incrementing the footer page number. A block never splits across a page; a
// block taller than a whole page still gets its own page (may overflow — flagged
// for visual tuning once the covers land and we can render live).
export function paginate(blocks: Block[], docTitle: string, startPage: number): { html: string; nextPage: number } {
  const pages: Block[][] = []
  let cur: Block[] = []
  let used = 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    // Break before this block if it overflows the page, OR if it's a heading that
    // would be orphaned — i.e. the heading fits but the block it introduces would
    // not fit after it. Only break when the current page already has content
    // (never open a page with a lone break), and only look one block ahead (a
    // heading is always followed by its body/list, never another heading).
    const overflow = used + b.h > PAGE_BUDGET
    const next = blocks[i + 1]
    const orphan = !!b.keepNext && !!next && used + b.h + next.h > PAGE_BUDGET
    if (cur.length > 0 && (overflow || orphan)) {
      pages.push(cur)
      cur = []
      used = 0
    }
    cur.push(b)
    used += b.h
  }
  if (cur.length > 0) pages.push(cur)

  let page = startPage
  const html = pages
    .map((blocksOnPage) => {
      const n = page++
      return `<section class="page"><div class="content">
  <div class="rhead">
    <div class="mark"><span class="dot">M</span>Micro-Training Method</div>
    <div class="doc">${esc(docTitle)}</div>
  </div>
  ${blocksOnPage.map((b) => b.html).join('\n  ')}
  <div class="spacer"></div>
  <div class="rfoot">
    <span class="brand">Micro-Training Method</span>
    <span class="dom">microtrainingmethod.com</span>
    <span>Page ${n}</span>
  </div>
</div></section>`
    })
    .join('\n')
  return { html, nextPage: page }
}

// Assemble the complete print-ready document: <head> with @page + all CSS, then
// the cover page followed by the paginated interior. This is the string POSTed to
// /api/pdf/render.
export function buildDocument(coverHtml: string, interiorHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: Letter; margin: 0; }
*{ box-sizing: border-box; }
html,body{ margin:0; padding:0; }
${coverCss()}
${INTERIOR_CSS}
</style></head><body>
${coverHtml}
${interiorHtml}
</body></html>`
}
