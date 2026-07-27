import { esc } from './html'
import { coverCss } from './cover'

// The interior shell (pages 2..N): the light-editorial frame shared by all three
// documents — running header, running footer with the domain + page number, and
// the section / card / table component set. The framework doc's redesigned look
// (fw-redesign-mockup) is ported verbatim below; the legacy renderers at the end
// (sectionHead / sub / body / list / callout / twoup / stats / divider) are kept
// unchanged for the guide + script bodies. Single column, page width, print-built.

// ── Inline SVG icons (from the mockup; stroke = navy / green-ink per context) ──
const ICONS: Record<string, string> = {
  client: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 3l9 6-9 6-9-6z"/><path d="M3 15l9 6 9-6"/></svg>',
  transform: '<svg viewBox="0 0 24 24"><path d="M4 17h10M14 17l-3-3M14 17l-3 3"/><path d="M20 7H10M10 7l3-3M10 7l3 3"/></svg>',
  framework: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  blueprints: '<svg viewBox="0 0 24 24"><path d="M4 4h16v13H4z"/><path d="M8 21h8M12 17v4M8 8h8M8 12h5"/></svg>',
  offers: '<svg viewBox="0 0 24 24"><path d="M4 20h4V10H4zM10 20h4V4h-4zM16 20h4v-7h-4z"/></svg>',
  program: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><path d="M4 4h16v11H4z"/><path d="M8 20h8M12 15v5"/><circle cx="12" cy="9" r="2.2"/></svg>',
}
// The four fixed insight-card icons (green-ink), in order.
const CARD_ICONS = [
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M3 12h7M14 12h7M10 8l4 8"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 21l-4.9-2.5.9-5.5-4-3.9L9.5 8z"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 01-12 7.7L3 21l1.8-6A8.5 8.5 0 1121 11.5z"/></svg>',
]
const STAR = '<polygon points="12,2 15,9 22,9 16,14 18,22 12,17 6,22 8,14 2,9 9,9"/>'

// The redesigned interior CSS is ported verbatim from the approved mockup, plus a
// small set of additions (phase cards, blueprint sub-blocks) and the legacy block
// classes the guide/script bodies still use. `.divider` is renamed `.stepdiv` so
// the full-page chalkboard step divider does not collide with the legacy hairline.
export const INTERIOR_CSS = `
:root{
  --navy:#050f2e; --navy2:#0c1c4d; --green:#6dd80e; --green-ink:#3f7d09;
  --ink:#1b2238; --muted:#6b7488; --line:#e7eaf1; --tintg:#f1fbe4; --tintn:#eef2fb;
  --paper:#ffffff; --chalk:#eef0f5; --tint:#f1fbe4;
}
.page{ width:816px; height:1056px; background:var(--paper); position:relative; overflow:hidden; page-break-after:always; }
.pad{ padding:60px 66px 64px; height:100%; display:flex; flex-direction:column; }

/* running header/footer */
.rhead{ display:flex; justify-content:space-between; align-items:center; padding-bottom:12px; border-bottom:1px solid var(--line); margin-bottom:26px; }
.rhead .mk{ display:flex; align-items:center; gap:8px; font-weight:800; color:var(--navy); font-size:12px; letter-spacing:.04em; }
.rhead .dot{ width:16px;height:16px;border-radius:50%;background:var(--green);display:inline-flex;align-items:center;justify-content:center;color:var(--navy);font-size:8px;font-weight:900; }
.rhead .doc{ color:var(--muted); font-size:10.5px; letter-spacing:.15em; text-transform:uppercase; font-weight:700; }
.rfoot{ margin-top:auto; display:flex; justify-content:space-between; align-items:center; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:10px; letter-spacing:.06em; }
.rfoot .b{ font-weight:800;color:var(--navy);letter-spacing:.12em;text-transform:uppercase; }
.rfoot .d{ color:var(--green-ink); font-weight:700; }

/* section title row with icon */
.stitle{ display:flex; align-items:center; gap:14px; margin-bottom:4px; }
.stitle .ic{ width:44px;height:44px;border-radius:12px;background:var(--tintn);display:flex;align-items:center;justify-content:center;flex:0 0 auto; }
.stitle .ic svg{ width:24px;height:24px;stroke:var(--navy);fill:none;stroke-width:1.7; }
.kick{ color:var(--green-ink); font-weight:800; letter-spacing:.15em; font-size:10.5px; text-transform:uppercase; }
h2{ font-size:26px; font-weight:800; letter-spacing:-.02em; color:var(--navy); line-height:1.08; }
.lead{ font-size:14px; line-height:1.6; color:#3a4260; margin:12px 0 4px; font-weight:500; }

/* ===== STEP DIVIDER (full page) ===== */
.stepdiv{ background:radial-gradient(130% 90% at 80% 6%,#12245a 0%,rgba(18,36,90,0) 55%),linear-gradient(180deg,#071231 0%,#050f2e 100%); color:var(--chalk); }
.stepdiv .wrap{ height:100%; display:flex; flex-direction:column; justify-content:center; padding:0 96px; position:relative; }
.stepdiv .num{ font-family:'MTM Chalk'; font-size:150px; line-height:.8; color:rgba(109,216,14,.16); position:absolute; top:120px; left:90px; }
.stepdiv .eyebrow{ color:var(--green); font-weight:800; letter-spacing:.28em; font-size:14px; text-transform:uppercase; margin-bottom:10px; }
.stepdiv h1{ font-family:'MTM Chalk'; font-size:104px; line-height:.98; color:#fff; margin:6px 0 4px; }
.stepdiv .rule{ width:120px; height:5px; background:var(--green); border-radius:3px; margin:22px 0 26px; }
.stepdiv .say{ font-size:18px; line-height:1.5; color:#c8d3ef; max-width:none; white-space:nowrap; font-weight:500; }
.stepdiv .atm{ position:absolute; top:120px; right:96px; display:flex; gap:10px; }
.stepdiv .atm b{ width:52px;height:52px;border:2.5px solid rgba(238,240,245,.5); border-radius:8px; display:flex;align-items:center;justify-content:center; font-family:'MTM Chalk'; font-size:30px; color:rgba(238,240,245,.55); }
.stepdiv .atm b.on{ border-color:var(--green); color:var(--green); }
.star{ position:absolute; stroke:var(--green); fill:none; stroke-width:2.5; opacity:.7; }

/* insight card grid */
.grid2{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:6px 0 4px; }
.card{ border:1px solid var(--line); border-radius:12px; padding:16px 18px; background:var(--paper); }
.card .h{ display:flex; align-items:center; gap:8px; font-size:10.5px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--green-ink); margin-bottom:8px; }
.card .h svg{ width:15px;height:15px;stroke:var(--green-ink);fill:none;stroke-width:1.8; }
.card p{ font-size:12.5px; line-height:1.55; color:var(--ink); }

/* avatar band */
.aband{ display:flex; gap:16px; align-items:center; background:var(--tintn); border-radius:14px; padding:16px 18px; margin:4px 0 16px; }
.aband .av{ width:56px;height:56px;border-radius:50%;background:var(--navy);color:#fff;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center;flex:0 0 auto; }
.aband .who{ font-size:16px;font-weight:800;color:var(--navy); }
.aband .id{ font-size:12.5px;line-height:1.5;color:#3a4260; margin-top:2px; }
.chip{ display:inline-block; background:#fff; border:1px solid var(--line); border-radius:999px; padding:3px 11px; font-size:10.5px; font-weight:700; color:var(--muted); margin-top:7px; }
.chip b{ color:var(--navy); }

h3{ font-size:14.5px; font-weight:800; color:var(--navy); margin:20px 0 9px; display:flex; align-items:center; gap:8px; }
h3 .tag{ font-size:9.5px; font-weight:800; color:var(--green-ink); letter-spacing:.1em; text-transform:uppercase; background:var(--tintg); padding:2px 8px; border-radius:6px; }
p.body{ font-size:12.5px; line-height:1.65; color:var(--ink); margin-bottom:10px; }
p.body strong, p.body b{ color:var(--navy); }

/* clean list as chips/rows */
.rows{ display:flex; flex-direction:column; gap:8px; }
.row{ display:flex; gap:10px; align-items:flex-start; background:#fbfcfe; border:1px solid var(--line); border-radius:9px; padding:10px 12px; }
.row .n{ width:18px;height:18px;border-radius:50%;background:var(--tintg);color:var(--green-ink);font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin-top:1px; }
.row p{ font-size:12px; line-height:1.5; color:var(--ink); }

/* transformation from/to + hero + deep strip */
.fromto{ display:flex; align-items:stretch; gap:0; margin:14px 0; }
.fromto .b{ flex:1; border:1px solid var(--line); border-radius:12px; padding:16px 18px; background:#fbfcfe; }
.fromto .b.to{ border-color:#cdeeb0; background:var(--tintg); }
.fromto .b h4{ font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:9px; }
.fromto .b.to h4{ color:var(--green-ink); }
.fromto .b p{ font-size:12px;line-height:1.55;color:var(--ink); }
.fromto .arrow{ width:44px; display:flex; align-items:center; justify-content:center; color:var(--green); font-size:26px; font-weight:800; }
.hero{ background:linear-gradient(90deg,var(--tintg),#fff); border-left:5px solid var(--green); border-radius:0 12px 12px 0; padding:16px 20px; margin:6px 0 4px; }
.hero .l{ font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--green-ink); }
.hero .t{ font-size:17px;font-weight:800;color:var(--navy);line-height:1.3;margin-top:5px; }
.deep{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-top:6px; }
.deep .d{ border-top:3px solid var(--navy); background:var(--tintn); border-radius:0 0 10px 10px; padding:13px 14px; }
.deep .d h5{ font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--navy);margin-bottom:7px; }
.deep .d p{ font-size:11px;line-height:1.5;color:var(--ink); }

/* phase cards (framework) — same visual language, colored per phase */
.phases{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin:8px 0 4px; }
.pcol{ border-top:3px solid var(--navy); background:var(--tintn); border-radius:0 0 10px 10px; padding:13px 14px; }
.pcol .pnm{ font-size:13.5px;font-weight:800;line-height:1.2; }
.pcol .ptl{ font-size:10.5px;font-weight:700;color:var(--muted);margin:3px 0 8px; }
.pcol .pst{ font-size:11px;line-height:1.45;color:var(--ink);margin-bottom:6px; }
.pcol .pst b{ color:var(--navy); }

/* offers 3-up */
.tiers{ display:flex; gap:12px; margin:8px 0 6px; align-items:stretch; }
.tier{ flex:1; border:1px solid var(--line); border-radius:14px; padding:16px 15px; background:var(--paper); display:flex; flex-direction:column; }
.tier.hi{ border:2px solid var(--green); box-shadow:0 8px 22px rgba(109,216,14,.13); position:relative; }
.tier .flag{ position:absolute; top:-10px; left:50%; transform:translateX(-50%); background:var(--green); color:var(--navy); font-size:8.5px; font-weight:900; letter-spacing:.1em; text-transform:uppercase; padding:3px 10px; border-radius:999px; }
.tier .lab{ font-size:9.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted); }
.tier .nm{ font-size:14px;font-weight:800;color:var(--navy);line-height:1.2;margin:6px 0 8px;min-height:34px; }
.tier .pr{ font-size:26px;font-weight:900;letter-spacing:-.02em;color:var(--navy); }
.tier.hi .pr{ color:var(--green-ink); }
.tier .pu{ font-size:10px;color:var(--muted);font-weight:600; }
.tier .one{ font-size:11px;line-height:1.5;color:#3a4260;margin-top:10px;padding-top:10px;border-top:1px solid var(--line); }

/* offer detail card */
.odet{ border:1px solid var(--line); border-left:5px solid var(--green); border-radius:0 12px 12px 0; padding:16px 20px; margin:12px 0; background:#fff; }
.odet .top{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px; }
.odet .top .nm{ font-size:15px;font-weight:800;color:var(--navy); }
.odet .top .pr{ font-size:15px;font-weight:900;color:var(--green-ink); }
.odet .kv{ margin-top:9px; }
.odet .kv .k{ font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted); }
.odet .kv .v{ font-size:12px;line-height:1.55;color:var(--ink);margin-top:2px; }

/* program table */
table.prog{ width:100%; border-collapse:collapse; margin:8px 0; font-size:11px; }
table.prog th{ background:var(--navy); color:#fff; font-size:9.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; text-align:left; padding:9px 11px; }
table.prog th:first-child{ border-radius:8px 0 0 0; } table.prog th:last-child{ border-radius:0 8px 0 0; }
table.prog td{ padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top; line-height:1.45; color:var(--ink); }
table.prog tr:nth-child(even) td{ background:#fafbfd; }
table.prog .wk{ font-weight:800; color:var(--navy); white-space:nowrap; }
table.prog .ph{ font-weight:700; }
table.prog .ph.p1{ color:#2563c9; } table.prog .ph.p2{ color:#7c3aed; } table.prog .ph.p3{ color:var(--green-ink); }

/* blueprint card */
.bp{ border:1px solid var(--line); border-radius:14px; overflow:hidden; margin:6px 0 14px; }
.bp .hd{ background:var(--navy); color:#fff; padding:13px 18px; display:flex; align-items:center; gap:10px; }
.bp .hd .no{ font-family:'MTM Chalk'; font-size:26px; color:var(--green); line-height:1; }
.bp .hd .t{ font-size:13.5px; font-weight:700; line-height:1.35; }
.bp .hd .badge{ margin-left:auto; background:var(--green); color:var(--navy); font-size:8.5px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; padding:3px 9px; border-radius:999px; white-space:nowrap; }
.bp .bd{ padding:15px 18px; }
.bp .q{ background:var(--tintg); border-left:4px solid var(--green); border-radius:0 8px 8px 0; padding:11px 15px; font-style:italic; font-size:12.5px; color:var(--navy); font-weight:600; line-height:1.5; margin:10px 0; }
.bptwo{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:10px 0; }
.bptwo .c{ border:1px solid var(--line); border-radius:9px; padding:11px 13px; background:#fbfcfe; }
.bptwo .c h6{ font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px; }
.bptwo .c p{ font-size:11.5px;line-height:1.5;color:var(--ink); }
.bpfit{ font-size:11.5px;color:#3a4260;margin:8px 0 2px; }
.bpfit b{ color:var(--navy); }
.mt{ background:var(--tintn); border-radius:12px; padding:14px 16px; margin-top:12px; }
.mt .lab{ display:flex;align-items:center;gap:8px; font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--navy); margin-bottom:4px; }
.mt .lab svg{ width:15px;height:15px;stroke:var(--navy);fill:none;stroke-width:1.8; }
.mt .ti{ font-size:13.5px;font-weight:800;color:var(--navy);line-height:1.3;margin-bottom:9px; }
.mt .step{ display:flex; gap:9px; margin-bottom:7px; }
.mt .step .n{ width:16px;height:16px;border-radius:4px;background:var(--green);color:var(--navy);font-size:9px;font-weight:900;display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin-top:1px; }
.mt .step p{ font-size:11.5px;line-height:1.45;color:var(--ink); }
.mt .step b{ color:var(--navy); }

/* ===== legacy classes (guide + script bodies) ===== */
.kicker{ color:var(--green-ink); font-weight:800; letter-spacing:.16em; font-size:11px; text-transform:uppercase; margin-bottom:9px; }
h2.section{ font-size:27px; font-weight:800; letter-spacing:-.02em; color:var(--navy); line-height:1.1; }
h3.sub{ font-size:16px; font-weight:800; color:var(--navy); margin:30px 0 10px; display:block; }
ul.list{ list-style:none; margin:8px 0 4px; }
ul.list li{ position:relative; padding-left:22px; font-size:13px; line-height:1.6; color:var(--ink); margin-bottom:10px; }
ul.list li::before{ content:""; position:absolute; left:2px; top:7px; width:7px; height:7px; border-radius:2px; background:var(--green); }
ul.list li b{ color:var(--navy); }
.callout{ background:var(--tint); border-left:4px solid var(--green); border-radius:0 8px 8px 0; padding:16px 20px; margin:16px 0; }
.callout .q{ font-size:14px; line-height:1.55; color:var(--navy); font-weight:600; font-style:italic; }
.callout .cite{ margin-top:8px; font-size:11px; color:var(--muted); font-weight:600; }
.twoup{ display:flex; gap:18px; margin:16px 0; }
.twoup .box{ flex:1; border:1px solid var(--line); border-radius:10px; padding:16px 18px; background:#fbfcfe; }
.twoup .box.win{ border-color:#cdeeb0; background:var(--tint); }
.twoup .box h4{ font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
.twoup .box.win h4{ color:var(--green-ink); }
.twoup .box p{ font-size:12.5px; line-height:1.55; color:var(--ink); }
.stats{ display:flex; gap:16px; margin:18px 0; }
.stat{ flex:1; border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
.stat .lab{ font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.stat .val{ font-size:30px; font-weight:900; letter-spacing:-.03em; color:var(--navy); margin-top:6px; line-height:1; }
.stat .val.g{ color:var(--green-ink); }
.divider{ height:1px; background:var(--line); margin:26px 0; }`

// ── Block model ───────────────────────────────────────────────────────────────
// An Atom is a single flowable unit with an estimated rendered height. A Split is
// a block whose rows may be distributed across pages (a table, a list of rows); on
// every page-chunk its wrapper (and, for a table, its header) is re-emitted, so a
// chunk is always self-contained. `keepNext` on an Atom binds it to the block that
// follows (no orphaned headings). Heights are conservative estimates — the render
// page runs no JS, so nothing can be measured live; we would rather leave a page a
// little short than clip.
export interface Row { html: string; h: number }
export interface Atom { html: string; h: number; keepNext?: boolean; breakBefore?: boolean; split?: false }
export interface Split { split: true; rows: Row[]; wrapOpen: string; wrapClose: string; chunkOverhead: number }
export type Block = Atom | Split

const CONTENT_W = 684 // 816 - 66*2
// Usable vertical space per page: 1056 - pad(60+64) - header(~70) - footer(~40).
const PAGE_BUDGET = 812

// Rough wrapped-line count for a run of text at a given font size.
function wraps(text: string, fontPx: number, width = CONTENT_W, ratio = 0.53): number {
  return Math.max(1, Math.ceil(((text || '').length * fontPx * ratio) / width))
}
// How much room a heading must reserve for the block it is bound to, so the
// heading is never left alone at the bottom of a page. For a split that fits a
// whole page we reserve the ENTIRE thing (short lists move down intact rather than
// breaking after one row); a split too big for a page reserves just its first
// chunk (heading + first rows travel together, the rest flows on).
const reserveFor = (b: Block): number => {
  if (!b.split) return b.h
  const total = b.chunkOverhead + b.rows.reduce((a, r) => a + r.h, 0)
  return total <= PAGE_BUDGET ? total : b.chunkOverhead + (b.rows[0]?.h ?? 0)
}

// ── framework redesign renderers (each returns a Block) ───────────────────────

// Icon + kicker + heading row (+ optional lead). Bound to the block after it.
export function sectionTitle(iconKey: string, kicker: string, title: string, lead?: string): Block {
  const ic = ICONS[iconKey] || ''
  const titleLines = wraps(title, 26, CONTENT_W - 58, 0.56)
  let h = 4 + Math.max(44, 16 + titleLines * 29)
  let leadHtml = ''
  if (lead) { leadHtml = `<div class="lead">${esc(lead)}</div>`; h += 12 + wraps(lead, 14) * 23 + 4 }
  const html = `<div class="stitle"><div class="ic">${ic}</div><div><div class="kick">${esc(kicker)}</div><h2>${esc(title)}</h2></div></div>${leadHtml}`
  // Each major section opens at the top of its own page (as in the mockup), so a
  // section title never crowds the block above it.
  return { html, h, keepNext: true, breakBefore: true }
}

// A mockup h3 (with an optional green "tag" chip). Bound to the block after it.
export function subHead(text: string, tag?: string): Block {
  const t = tag ? `<span class="tag">${esc(tag)}</span>` : ''
  return { html: `<h3>${esc(text)}${t}</h3>`, h: 20 + 9 + wraps(text, 14.5) * 18, keepNext: true }
}

// A framework paragraph (mockup p.body). innerHtml is ready HTML (may hold <b>).
export function para(innerHtml: string, textLen: number): Block {
  return { html: `<p class="body">${innerHtml}</p>`, h: wraps('x'.repeat(textLen), 12.5) * 21 + 10 }
}

export function avatarBand(initial: string, name: string, idLine: string, emotion?: string): Block {
  let h = 20 + 32 + 22 + wraps(idLine, 12.5, 560) * 19
  let chip = ''
  if (emotion) { chip = `<span class="chip">Emotional state: <b>${esc(emotion)}</b></span>`; h += 33 }
  const html = `<div class="aband"><div class="av">${esc(initial)}</div><div><div class="who">${esc(name)}</div><div class="id">${esc(idLine)}</div>${chip}</div></div>`
  return { html, h }
}

// The four fixed insight cards (real problem / core gap / what they want / connect).
export function cardGrid(items: { label: string; text: string }[]): Block {
  const cardW = (CONTENT_W - 14) / 2 - 36
  const cardH = (it: { text: string }) => 32 + 19 + wraps(it.text, 12.5, cardW) * 19
  let h = 6 + 4
  for (let i = 0; i < items.length; i += 2) h += Math.max(cardH(items[i]), items[i + 1] ? cardH(items[i + 1]) : 0) + (i > 0 ? 14 : 0)
  const cell = (it: { label: string; text: string }, i: number) =>
    `<div class="card"><div class="h">${CARD_ICONS[i % CARD_ICONS.length]}${esc(it.label)}</div><p>${esc(it.text)}</p></div>`
  return { html: `<div class="grid2">${items.map(cell).join('')}</div>`, h }
}

// Numbered (or ✓) rows — splittable row-by-row.
export function rowsList(items: string[], marker: 'num' | 'check' = 'num'): Split {
  const rowW = CONTENT_W - 12 - 24
  const rows: Row[] = items.map((t, i) => ({
    html: `<div class="row"><span class="n">${marker === 'check' ? '✓' : String(i + 1)}</span><p>${esc(t)}</p></div>`,
    h: 20 + wraps(t, 12, rowW) * 18 + 8,
  }))
  return { split: true, rows, wrapOpen: '<div class="rows">', wrapClose: '</div>', chunkOverhead: 4 }
}

export function heroBand(label: string, text: string): Block {
  const html = `<div class="hero"><div class="l">${esc(label)}</div><div class="t">${esc(text)}</div></div>`
  return { html, h: 10 + 32 + 13 + 5 + wraps(text, 17, CONTENT_W - 40) * 23 }
}

export function fromTo(from: string, to: string): Atom {
  const bw = (CONTENT_W - 44) / 2 - 36
  const h = 28 + 32 + 14 + 9 + Math.max(wraps(from, 12, bw), wraps(to, 12, bw)) * 19
  const html = `<div class="fromto"><div class="b"><h4>From this</h4><p>${esc(from)}</p></div><div class="arrow">&#8594;</div><div class="b to"><h4>To this</h4><p>${esc(to)}</p></div></div>`
  return { html, h }
}

export function deepStrip(items: { label: string; text: string }[]): Block {
  const cw = (CONTENT_W - 24) / 3 - 28
  const colH = (it: { text: string }) => 29 + 13 + 7 + wraps(it.text, 11, cw) * 17
  const html = `<div class="deep">${items.map((it) => `<div class="d"><h5>${esc(it.label)}</h5><p>${esc(it.text)}</p></div>`).join('')}</div>`
  return { html, h: 6 + Math.max(...items.map(colH)) }
}

// Framework phases as three colored columns; steps as "<b>name.</b> outcome".
export function phaseCards(phases: { name: string; tagline: string; steps: { name: string; outcome: string }[] }[]): Block {
  const COLORS = ['#2563c9', '#7c3aed', '#3f7d09']
  const cw = (CONTENT_W - 24) / 3 - 28
  const colH = (p: { tagline: string; steps: { name: string; outcome: string }[] }) =>
    13 + 20 + (p.tagline ? 16 : 0) + p.steps.reduce((a, s) => a + wraps(`${s.name}. ${s.outcome}`, 11, cw) * 16 + 6, 0) + 8
  const col = (p: { name: string; tagline: string; steps: { name: string; outcome: string }[] }, i: number) => {
    const steps = p.steps.map((s) => `<div class="pst"><b>${esc(s.name)}.</b> ${esc(s.outcome)}</div>`).join('')
    const tl = p.tagline ? `<div class="ptl">${esc(p.tagline)}</div>` : ''
    return `<div class="pcol" style="border-top-color:${COLORS[i % 3]}"><div class="pnm" style="color:${COLORS[i % 3]}">${esc(p.name)}</div>${tl}${steps}</div>`
  }
  return { html: `<div class="phases">${phases.map(col).join('')}</div>`, h: 8 + Math.max(...phases.map(colH), 40) }
}

export function tierRow(tiers: { lab: string; name: string; price: string; unit?: string; one: string; hi?: boolean }[]): Block {
  const tw = CONTENT_W / tiers.length - 30
  const th = (t: { one: string }) => 32 + 13 + 34 + 30 + 20 + wraps(t.one, 11, tw) * 17
  const cell = (t: { lab: string; name: string; price: string; unit?: string; one: string; hi?: boolean }) =>
    `<div class="tier${t.hi ? ' hi' : ''}">${t.hi ? '<div class="flag">Primary offer</div>' : ''}<div class="lab">${esc(t.lab)}</div><div class="nm">${esc(t.name)}</div><div class="pr">${esc(t.price)}${t.unit ? `<span class="pu">${esc(t.unit)}</span>` : ''}</div><div class="one">${esc(t.one)}</div></div>`
  return { html: `<div class="tiers">${tiers.map(cell).join('')}</div>`, h: 14 + Math.max(...tiers.map(th)) }
}

export function offerDetail(o: { name: string; price: string; kv: { k: string; v: string }[] }): Block {
  const vw = CONTENT_W - 40
  let h = 24 + 32 + 18
  const kvHtml = o.kv.map((x) => { h += 9 + 13 + wraps(x.v, 12, vw) * 19; return `<div class="kv"><div class="k">${esc(x.k)}</div><div class="v">${esc(x.v)}</div></div>` }).join('')
  return { html: `<div class="odet"><div class="top"><span class="nm">${esc(o.name)}</span><span class="pr">${esc(o.price)}</span></div>${kvHtml}</div>`, h }
}

// The week-by-week table — splittable row-by-row; the <thead> re-emits per chunk.
export function programTable(rows: { week: string; phase: string; phaseClass: string; focus: string; milestone: string }[]): Split {
  const r: Row[] = rows.map((x) => ({
    html: `<tr><td class="wk">Week ${esc(x.week)}</td><td class="ph ${x.phaseClass}">${esc(x.phase)}</td><td>${esc(x.focus)}</td><td>${esc(x.milestone)}</td></tr>`,
    h: 18 + Math.max(wraps(x.focus, 11, 320), wraps(x.milestone, 11, 150)) * 16,
  }))
  const wrapOpen = `<table class="prog"><thead><tr><th style="width:64px">Week</th><th style="width:120px">Phase</th><th>Focus</th><th style="width:150px">Client milestone</th></tr></thead><tbody>`
  return { split: true, rows: r, wrapOpen, wrapClose: '</tbody></table>', chunkOverhead: 50 }
}

export interface BlueprintData {
  no: string; title: string; badge?: boolean
  solution?: string; quote?: string; cost?: string; objection?: string
  before?: string; after?: string; fit?: string
  mtTitle?: string; steps: { point: string; detail: string }[]
}
// A blueprint card, exactly as the approved mockup shows it: navy header (chalk
// number + problem + optional "strongest match" badge), "The solution." line, the
// audience quote, and the micro-training box. Sized to sit on one page with its
// section title; a genuinely oversized one splits once at the micro-training
// boundary (problem/solution card, then the training as a matching card).
export function blueprintCard(bp: BlueprintData): Block {
  const bw = CONTENT_W - 36
  let cardH = 26 + wraps(bp.title, 13.5, bw - 60) * 18 + 30
  let bd = ''
  if (bp.solution) { bd += `<p class="body"><b>The solution.</b> ${esc(bp.solution)}</p>`; cardH += wraps('x'.repeat(bp.solution.length + 14), 12.5, bw) * 21 + 10 }
  if (bp.quote) { bd += `<div class="q">${esc(bp.quote)}</div>`; cardH += 22 + wraps(bp.quote, 12.5, bw - 30) * 19 + 20 }

  const badge = bp.badge ? '<span class="badge">Strongest match</span>' : ''
  const header = `<div class="hd"><span class="no">${esc(bp.no)}</span><span class="t">${esc(bp.title)}</span>${badge}</div>`

  let mtHtml = ''
  let mtH = 0
  if (bp.mtTitle || bp.steps.length) {
    const steps = bp.steps.map((s, i) => `<div class="step"><span class="n">${i + 1}</span><p><b>${esc(s.point)}.</b> ${esc(s.detail)}</p></div>`).join('')
    mtHtml = `<div class="mt"><div class="lab">${ICONS.screen}The micro-training that teaches it</div>${bp.mtTitle ? `<div class="ti">${esc(bp.mtTitle)}</div>` : ''}${steps}</div>`
    mtH = 28 + (bp.mtTitle ? 24 + wraps(bp.mtTitle, 13.5, bw - 32) * 18 : 0) + bp.steps.reduce((a, s) => a + wraps(`${s.point}. ${s.detail}`, 11.5, bw - 60) * 17 + 7, 0)
  }

  if (!mtHtml) return { html: `<div class="bp">${header}<div class="bd">${bd}</div></div>`, h: cardH }
  // Leave headroom for the section title that may share the page; only split when
  // the whole card genuinely can't fit alongside it.
  if (cardH + mtH <= PAGE_BUDGET - 170) return { html: `<div class="bp">${header}<div class="bd">${bd}${mtHtml}</div></div>`, h: cardH + mtH }
  const row1: Row = { html: `<div class="bp">${header}<div class="bd">${bd}</div></div>`, h: cardH }
  const row2: Row = { html: `<div class="bp"><div class="bd">${mtHtml.replace('class="mt"', 'class="mt" style="margin-top:0"')}</div></div>`, h: 30 + mtH }
  return { split: true, rows: [row1, row2], wrapOpen: '', wrapClose: '', chunkOverhead: 0 }
}

// ── step divider (a full page) ────────────────────────────────────────────────
export interface DividerSpec { n: string; name: string; line: string; active: 'A' | 'T' | 'M' }
export function stepDividerPage(d: DividerSpec): string {
  const box = (l: 'A' | 'T' | 'M') => `<b${d.active === l ? ' class="on"' : ''}>${l}</b>`
  return `<section class="page stepdiv"><div class="wrap">
  <svg class="star" style="top:90px;left:60px" width="46" height="46" viewBox="0 0 24 24">${STAR}</svg>
  <svg class="star" style="bottom:120px;right:80px" width="60" height="60" viewBox="0 0 24 24">${STAR}</svg>
  <svg class="star" style="bottom:90px;left:110px" width="34" height="34" viewBox="0 0 24 24">${STAR}</svg>
  <div class="num">${esc(d.n)}</div>
  <div class="atm">${box('A')}${box('T')}${box('M')}</div>
  <div class="eyebrow">Step ${esc(d.n.replace(/^0/, ''))} of 3</div>
  <h1>${esc(d.name)}</h1>
  <div class="rule"></div>
  <div class="say">${esc(d.line)}</div>
</div></section>`
}

// ── legacy renderers (guide + script bodies — unchanged) ──────────────────────
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
export function body(innerHtml: string, textLen: number): Block {
  return { html: `<p class="body">${innerHtml}</p>`, h: wraps('x'.repeat(textLen), 13) * 22 + 12 }
}
export function list(items: string[]): Block {
  const lis = items.map((it) => `<li>${it}</li>`).join('')
  const h = items.reduce((acc, it) => acc + wraps(it.replace(/<[^>]+>/g, ''), 13, CONTENT_W - 22) * 21 + 10, 0)
  return { html: `<ul class="list">${lis}</ul>`, h: h + 12 }
}
export function callout(quote: string, cite?: string): Block {
  const c = cite ? `<div class="cite">${esc(cite)}</div>` : ''
  const h = 32 + wraps(quote, 14) * 22 + (cite ? 8 + 16 : 0) + 32
  return { html: `<div class="callout"><div class="q">${esc(quote)}</div>${c}</div>`, h }
}
export function twoup(left: { h4: string; body: string }, right: { h4: string; body: string; win?: boolean }): Block {
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

// ── paginator ─────────────────────────────────────────────────────────────────
// Pack blocks into fixed-height .page sections, repeating the running header and
// incrementing the footer page number. Atoms never split; a heading (keepNext) is
// never left as the last block on a page. A Split flows row-by-row: it is kept
// whole when it fits (on this page, else the next), and only broken across pages
// when it genuinely exceeds one — re-emitting its wrapper (and table header) per
// chunk. `startPage` is the first page number to print.
export function paginate(blocks: Block[], docTitle: string, startPage: number): { html: string; nextPage: number } {
  const pages: string[][] = []
  let cur: string[] = []
  let used = 0
  const flush = () => { if (cur.length) { pages.push(cur); cur = []; used = 0 } }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const pinned = i > 0 && !blocks[i - 1].split && (blocks[i - 1] as Atom).keepNext === true

    if (!b.split) {
      if (b.breakBefore && cur.length > 0) flush()
      let need = b.h
      if (b.keepNext && blocks[i + 1]) need += reserveFor(blocks[i + 1])
      if (!pinned && cur.length > 0 && used + need > PAGE_BUDGET) flush()
      cur.push(b.html)
      used += b.h
      continue
    }

    // Split block.
    const total = b.chunkOverhead + b.rows.reduce((a, r) => a + r.h, 0)
    if (used + total <= PAGE_BUDGET) {
      cur.push(b.wrapOpen + b.rows.map((r) => r.html).join('') + b.wrapClose)
      used += total
    } else if (!pinned && total <= PAGE_BUDGET) {
      flush()
      cur.push(b.wrapOpen + b.rows.map((r) => r.html).join('') + b.wrapClose)
      used += total
    } else {
      // Split across pages. The first chunk stays on the current page when pinned
      // (so the heading above it is never orphaned), otherwise it may start fresh.
      let idx = 0
      let firstChunk = true
      while (idx < b.rows.length) {
        if (!(pinned && firstChunk) && cur.length > 0 && used + b.chunkOverhead + b.rows[idx].h > PAGE_BUDGET) flush()
        const chunk: string[] = []
        let chunkH = b.chunkOverhead
        while (idx < b.rows.length && used + chunkH + b.rows[idx].h <= PAGE_BUDGET) {
          chunk.push(b.rows[idx].html); chunkH += b.rows[idx].h; idx++
        }
        if (chunk.length === 0) { chunk.push(b.rows[idx].html); chunkH += b.rows[idx].h; idx++ }
        cur.push(b.wrapOpen + chunk.join('') + b.wrapClose)
        used += chunkH
        firstChunk = false
        if (idx < b.rows.length) flush()
      }
    }
  }
  flush()

  let page = startPage
  const html = pages
    .map((blocksOnPage) => {
      const n = page++
      return `<section class="page"><div class="pad">
  <div class="rhead">
    <div class="mk"><span class="dot">M</span>Micro-Training Method</div>
    <div class="doc">${esc(docTitle)}</div>
  </div>
  ${blocksOnPage.join('\n  ')}
  <div class="rfoot">
    <span class="b">Micro-Training Method</span>
    <span class="d">microtrainingmethod.com</span>
    <span>Page ${n}</span>
  </div>
</div></section>`
    })
    .join('\n')
  return { html, nextPage: page }
}

// A framework step = its chalkboard divider page + the paginated content that
// follows it. Dividers are physical pages (they advance the page counter) but
// carry no printed number.
export interface StepSection { divider: DividerSpec; blocks: Block[] }
export function assembleSteps(sections: StepSection[], docTitle: string, startPage: number): { html: string; nextPage: number } {
  let page = startPage
  const parts: string[] = []
  for (const s of sections) {
    parts.push(stepDividerPage(s.divider))
    page++
    const { html, nextPage } = paginate(s.blocks, docTitle, page)
    parts.push(html)
    page = nextPage
  }
  return { html: parts.join('\n'), nextPage: page }
}

// Assemble the complete print-ready document: <head> with @page + all CSS, then
// the cover page followed by the interior. Posted to /api/pdf/render.
export function buildDocument(coverHtml: string, interiorHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: Letter; margin: 0; }
*{ box-sizing: border-box; }
html,body{ margin:0; padding:0; }
body{ font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
${coverCss()}
${INTERIOR_CSS}
</style></head><body>
${coverHtml}
${interiorHtml}
</body></html>`
}
