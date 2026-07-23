import type { VercelRequest, VercelResponse } from '@vercel/node'
import { loadPublishedListings, HUB_CATEGORIES, HubCard } from '../../lib/hub'

// GET /api/hub/render — PUBLIC server-rendered Training Hub catalog, served at
// the freeminiworkshop.com apex (via the vercel.json rewrite). Same inline-HTML
// pattern as api/funnels/render.ts; calls the shared loader directly (no HTTP
// hop). A premium "wall" of free mini-trainings, each card an <a> out to the
// coach's funnel. Client-side search + category chips filter in place.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  try {
    const listings = await loadPublishedListings()
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
    return res.status(200).send(renderHub(listings))
  } catch (err) {
    console.error('[hub/render]', err)
    return res.status(200).send(renderHub([]))
  }
}

// Deterministic accent for a card whose cover is unset — a small tasteful
// palette keyed by the title, so the fallback wall still feels varied.
const FALLBACK_PALETTE = ['#020c31', '#0b3d2e', '#3a1f5d', '#5a2a1e', '#123a5e', '#4a1d3f']
function fallbackColor(seed: string): string {
  let sum = 0
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i)
  return FALLBACK_PALETTE[sum % FALLBACK_PALETTE.length]
}

function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function coverHtml(c: HubCard): string {
  if (c.cover_url) {
    return `<div class="cover"><img src="${escapeAttr(c.cover_url)}" alt="" loading="lazy" /></div>`
  }
  return `<div class="cover cover-fallback" style="background:${fallbackColor(c.title || c.id)};"><span class="cover-title">${escapeHtml(c.title)}</span></div>`
}

function cardHtml(c: HubCard): string {
  const search = escapeAttr(`${c.title} ${c.coach_name} ${c.category}`.toLowerCase())
  return `<a class="card hub-card" href="${escapeAttr(c.target_url)}" data-cat="${escapeAttr(c.category)}" data-search="${search}">
    ${coverHtml(c)}
    <div class="card-body">
      <span class="badge">Free</span>
      <h3 class="card-title">${escapeHtml(c.title)}</h3>
      <div class="card-coach">${escapeHtml(c.coach_name)}</div>
      ${c.hook ? `<p class="card-hook">${escapeHtml(c.hook)}</p>` : ''}
    </div>
  </a>`
}

function renderHub(listings: HubCard[]): string {
  const featured = listings.filter((l) => l.featured)
  // Categories present, in taxonomy order.
  const present = HUB_CATEGORIES.filter((cat) => listings.some((l) => l.category === cat))

  const chips = present
    .map((cat) => `<button type="button" class="chip" data-cat="${escapeAttr(cat)}">${escapeHtml(sentenceCase(cat))}</button>`)
    .join('')

  const featuredStrip = featured.length
    ? `<section class="group" data-group="featured">
        <h2 class="group-title">Featured</h2>
        <div class="strip">${featured.map(cardHtml).join('')}</div>
      </section>`
    : ''

  const sections = present
    .map(
      (cat) => `<section class="group" data-group="${escapeAttr(cat)}">
        <h2 class="group-title">${escapeHtml(sentenceCase(cat))}</h2>
        <div class="grid">${listings.filter((l) => l.category === cat).map(cardHtml).join('')}</div>
      </section>`
    )
    .join('')

  const emptyState = listings.length
    ? ''
    : `<div class="empty"><h2>New trainings are on the way</h2><p>Check back soon for free mini-trainings from top coaches.</p></div>`

  const controls = listings.length
    ? `<div class="controls">
        <input id="search" type="search" placeholder="Search trainings, coaches, topics" autocomplete="off" />
        <div class="chips"><button type="button" class="chip active" data-cat="">All</button>${chips}</div>
      </div>`
    : ''

  const body = `
    <header class="hero">
      <div class="wrap">
        <h1>Free mini-trainings</h1>
        <p class="sub">A curated wall of short, free trainings from coaches worth learning from. Pick one and start.</p>
        ${controls}
      </div>
    </header>
    <main class="wrap">
      ${featuredStrip}
      ${sections}
      ${emptyState}
      <div id="noresults" class="empty" style="display:none;"><h2>Nothing matches that</h2><p>Try a different search or category.</p></div>
    </main>`

  const script = `
    var searchEl = document.getElementById('search');
    var q = '', cat = '';
    function apply(){
      var cards = document.querySelectorAll('.hub-card');
      cards.forEach(function(c){
        var okText = !q || (c.getAttribute('data-search') || '').indexOf(q) !== -1;
        var okCat = !cat || c.getAttribute('data-cat') === cat;
        c.classList.toggle('hidden', !(okText && okCat));
      });
      document.querySelectorAll('.group').forEach(function(g){
        g.classList.toggle('hidden', !g.querySelector('.hub-card:not(.hidden)'));
      });
      var any = document.querySelector('.hub-card:not(.hidden)');
      var nr = document.getElementById('noresults'); if (nr) nr.style.display = any ? 'none' : 'block';
    }
    if (searchEl) searchEl.addEventListener('input', function(){ q = this.value.trim().toLowerCase(); apply(); });
    document.querySelectorAll('.chip').forEach(function(ch){
      ch.addEventListener('click', function(){
        cat = this.getAttribute('data-cat') || '';
        document.querySelectorAll('.chip').forEach(function(x){ x.classList.remove('active'); });
        this.classList.add('active');
        apply();
      });
    });`

  return shell('Free mini-trainings', body, script)
}

function shell(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    *{box-sizing:border-box}html,body{margin:0}
    :root{--bg:#0b1020;--card:#141a2e;--line:rgba(255,255,255,.08);--text:#f4f6fb;--muted:#9aa3bd;--accent:#6dd80e}
    body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;}
    .wrap{max-width:1120px;margin:0 auto;padding:0 20px;}
    .hero{padding:56px 0 20px;background:radial-gradient(1200px 400px at 50% -10%, rgba(109,216,14,.10), transparent);}
    .hero h1{font-size:clamp(1.9rem,5vw,2.8rem);margin:0 0 .4rem;letter-spacing:-.02em;}
    .sub{color:var(--muted);font-size:1.05rem;margin:0 0 1.5rem;max-width:640px;}
    .controls{display:flex;flex-direction:column;gap:14px;margin-top:8px;}
    #search{width:100%;max-width:520px;padding:12px 16px;border-radius:12px;border:1px solid var(--line);background:#0f1526;color:var(--text);font-size:1rem;}
    .chips{display:flex;flex-wrap:wrap;gap:8px;}
    .chip{padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--muted);font-size:.9rem;cursor:pointer;}
    .chip.active{background:var(--text);color:#0b1020;border-color:var(--text);font-weight:600;}
    main.wrap{padding-bottom:72px;}
    .group{margin-top:40px;}
    .group.hidden{display:none;}
    .group-title{font-size:1.15rem;margin:0 0 16px;letter-spacing:-.01em;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:18px;}
    .strip{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(240px,280px);gap:18px;overflow-x:auto;padding-bottom:8px;scroll-snap-type:x mandatory;}
    .strip .card{scroll-snap-align:start;}
    .card{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;transition:transform .15s ease,border-color .15s ease;}
    .card:hover{transform:translateY(-3px);border-color:rgba(109,216,14,.5);}
    .card.hidden{display:none;}
    .cover{position:relative;aspect-ratio:16/9;background:#0f1526;}
    .cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
    .cover-fallback{display:flex;align-items:center;justify-content:center;padding:18px;}
    .cover-title{font-size:1.05rem;font-weight:700;color:#fff;text-align:center;line-height:1.25;}
    .card-body{padding:14px 16px 18px;display:flex;flex-direction:column;gap:6px;}
    .badge{align-self:flex-start;font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0b1020;background:var(--accent);border-radius:6px;padding:3px 8px;}
    .card-title{font-size:1.02rem;margin:2px 0 0;line-height:1.25;}
    .card-coach{font-size:.85rem;color:var(--muted);}
    .card-hook{font-size:.9rem;color:var(--muted);margin:4px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
    .empty{text-align:center;padding:72px 20px;color:var(--muted);}
    .empty h2{color:var(--text);margin:0 0 8px;}
  </style>
</head>
<body>
  ${body}
  <script>${script}</script>
</body></html>`
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
function escapeAttr(s: unknown): string {
  return escapeHtml(s)
}
