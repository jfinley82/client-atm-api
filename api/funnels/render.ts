import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

// PUBLIC — no auth. Resolves a LIVE funnel from the request's subdomain and
// serves its real pages, routed by ?page= (landing | training | book; default
// landing). Copy + brand kit come from the funnel row; the training page's key
// takeaways come from the linked mtm_generations. Page views are logged to
// funnel_events (best-effort). Booking reuses the existing native calendar
// (/api/calendar/*); a successful booking is logged 'booked' via the public
// event beacon (/api/funnel/event).
//
// Subdomain resolution: the leftmost label of the Host header, with a
// ?subdomain= query override so the lookup is testable before wildcard DNS.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const rawQuery = req.query?.subdomain
  const querySub = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery
  const host = (req.headers.host || '').split(':')[0]
  const hostSub = host.split('.')[0]
  const subdomain = (querySub && String(querySub)) || hostSub

  const rawPage = req.query?.page
  const pageParam = (Array.isArray(rawPage) ? rawPage[0] : rawPage) || 'landing'
  const page = ['landing', 'training', 'book'].includes(String(pageParam)) ? String(pageParam) : 'landing'

  if (!subdomain) return send404(res)

  const { data: funnel, error } = await supabase
    .from('funnels')
    .select(
      'id, subdomain, status, generation_id, brand_primary_color, brand_secondary_color, theme_mode, brand_font, logo_url, headshot_url, video_url, collect_name, collect_phone, landing_page, training_page, booking_page'
    )
    .eq('subdomain', subdomain)
    .maybeSingle()

  if (error) {
    console.error('[funnels/render]', error)
    return res.status(500).json({ error: 'Failed to render funnel' })
  }
  if (!funnel || funnel.status !== 'live') return send404(res)

  // Best-effort page-view event. landing_view / training_view; the book page is
  // reached by clicking the "book a call" CTA, so its load is a booking_click.
  const viewEvent = page === 'training' ? 'training_view' : page === 'book' ? 'booking_click' : 'landing_view'
  logEvent(funnel.id, viewEvent)

  const brand = brandKit(funnel)
  let html: string
  if (page === 'training') html = trainingPage(funnel, brand, await loadKeyTakeaways(funnel.generation_id))
  else if (page === 'book') html = bookPage(funnel, brand)
  else html = landingPage(funnel, brand)

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.status(200).send(html)
}

// ---- data helpers -------------------------------------------------------

async function loadKeyTakeaways(generationId: string | null): Promise<string[]> {
  if (!generationId) return []
  const { data } = await supabase.from('mtm_generations').select('workbook').eq('id', generationId).maybeSingle()
  const kt = (data?.workbook as { keyTakeaways?: unknown } | null)?.keyTakeaways
  return Array.isArray(kt) ? kt.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
}

function logEvent(funnelId: string, eventType: string): void {
  // Fire-and-forget — never block or fail the page render on analytics.
  void supabase
    .from('funnel_events')
    .insert({ funnel_id: funnelId, event_type: eventType })
    .then(({ error }) => {
      if (error) console.error('[funnels/render] logEvent', eventType, error)
    })
}

// ---- rendering ----------------------------------------------------------

type Brand = { primary: string; secondary: string; isDark: boolean; text: string; bg: string; muted: string; card: string; font: string }

function brandKit(funnel: Record<string, any>): Brand {
  const primary = funnel.brand_primary_color || '#020c31'
  const secondary = funnel.brand_secondary_color || '#6dd80e'
  const isDark = funnel.theme_mode !== 'light'
  const font = typeof funnel.brand_font === 'string' && funnel.brand_font.trim()
    ? funnel.brand_font.trim()
    : '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  return {
    primary,
    secondary,
    isDark,
    font,
    text: isDark ? '#ffffff' : primary,
    bg: isDark ? primary : '#ffffff',
    muted: isDark ? 'rgba(255,255,255,.72)' : 'rgba(2,12,49,.72)',
    card: isDark ? 'rgba(255,255,255,.06)' : 'rgba(2,12,49,.04)',
  }
}

function shell(brand: Brand, title: string, body: string, script = ''): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="${brand.isDark ? 'dark' : 'light'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      background: ${brand.bg}; color: ${brand.text};
      font-family: ${brand.font};
      line-height: 1.5; padding: 0;
    }
    .wrap { max-width: 720px; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
    .logo { max-height: 44px; margin-bottom: 2rem; }
    h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); line-height: 1.15; margin: 0 0 .75rem; }
    .sub { font-size: 1.15rem; color: ${brand.muted}; margin: 0 0 2rem; }
    h2 { font-size: 1.25rem; margin: 2rem 0 .75rem; }
    ul { padding-left: 1.1rem; margin: 0 0 1.75rem; }
    li { margin: .5rem 0; }
    .card { background: ${brand.card}; border-radius: 14px; padding: 1.5rem; }
    label { display: block; font-size: .85rem; margin: 1rem 0 .35rem; color: ${brand.muted}; }
    input {
      width: 100%; padding: .8rem .9rem; border-radius: 10px; font-size: 1rem;
      border: 1px solid ${brand.isDark ? 'rgba(255,255,255,.2)' : 'rgba(2,12,49,.2)'};
      background: ${brand.isDark ? 'rgba(255,255,255,.04)' : '#fff'}; color: ${brand.text};
    }
    button, .btn {
      display: inline-block; width: 100%; margin-top: 1.5rem; padding: .95rem 1.2rem;
      border: 0; border-radius: 10px; background: ${brand.secondary}; color: ${brand.primary};
      font-size: 1.05rem; font-weight: 700; cursor: pointer; text-align: center; text-decoration: none;
    }
    button:disabled { opacity: .6; cursor: default; }
    .headshot { width: 72px; height: 72px; border-radius: 9999px; object-fit: cover; margin-bottom: 1rem; }
    .video { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 14px; overflow: hidden; background: #000; margin-bottom: 1.5rem; }
    .video iframe, .video video { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .err { color: #ff6b6b; font-size: .9rem; margin-top: .75rem; min-height: 1.1rem; }
    .slot { display: block; width: 100%; text-align: left; margin: .4rem 0; background: ${brand.card}; color: ${brand.text}; }
    .muted { color: ${brand.muted}; }
  </style>
</head>
<body>
  <main class="wrap">
    ${body}
  </main>
  ${script ? `<script>${script}</script>` : ''}
</body>
</html>`
}

function logoTag(funnel: Record<string, any>): string {
  return funnel.logo_url ? `<img class="logo" src="${escapeAttr(funnel.logo_url)}" alt="" />` : ''
}

function landingPage(funnel: Record<string, any>, brand: Brand): string {
  const lp = (funnel.landing_page || {}) as Record<string, any>
  const headline = escapeHtml(lp.headline || 'A free training for you')
  const sub = lp.subheadline ? `<p class="sub">${escapeHtml(lp.subheadline)}</p>` : ''
  const problems = bullets(lp.problem_bullets)
  const solutions = bullets(lp.solution_bullets)
  const cta = escapeHtml(lp.cta_label || 'Watch the free training')

  const nameField = funnel.collect_name
    ? `<label for="first_name">First name</label><input id="first_name" name="first_name" autocomplete="given-name" />`
    : ''
  const phoneField = funnel.collect_phone
    ? `<label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel" />`
    : ''

  const body = `
    ${logoTag(funnel)}
    <h1>${headline}</h1>
    ${sub}
    ${problems ? `<h2>Sound familiar?</h2><ul>${problems}</ul>` : ''}
    ${solutions ? `<h2>Here's what you'll get</h2><ul>${solutions}</ul>` : ''}
    <div class="card">
      <form id="optin">
        ${nameField}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
        ${phoneField}
        <button type="submit" id="submit">${cta}</button>
        <div class="err" id="err"></div>
      </form>
    </div>`

  const script = `
    var FUNNEL_ID = ${JSON.stringify(funnel.id)};
    var SUB = ${JSON.stringify(funnel.subdomain)};
    function nextUrl(page){ var u = new URL(window.location.href); u.searchParams.set('page', page); return u.toString(); }
    document.getElementById('optin').addEventListener('submit', function(e){
      e.preventDefault();
      var btn = document.getElementById('submit'); var err = document.getElementById('err');
      err.textContent = ''; btn.disabled = true;
      var body = { funnel_id: FUNNEL_ID, subdomain: SUB, email: (document.getElementById('email')||{}).value };
      var fn = document.getElementById('first_name'); if (fn) body.first_name = fn.value;
      var ph = document.getElementById('phone'); if (ph) body.phone = ph.value;
      fetch('/api/funnel/lead', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          if (!res.ok) { err.textContent = res.j && res.j.error ? res.j.error : 'Something went wrong'; btn.disabled = false; return; }
          window.location.href = nextUrl(res.j && res.j.next ? res.j.next : 'training');
        })
        .catch(function(){ err.textContent = 'Network error, please try again'; btn.disabled = false; });
    });`

  return shell(brand, lp.headline || 'Free training', body, script)
}

function trainingPage(funnel: Record<string, any>, brand: Brand, takeaways: string[]): string {
  const tp = (funnel.training_page || {}) as Record<string, any>
  const headline = escapeHtml(tp.headline || 'Your training')
  const sub = tp.subheadline ? `<p class="sub">${escapeHtml(tp.subheadline)}</p>` : ''
  const cta = escapeHtml(tp.cta_label || 'Book a call')
  const video = videoEmbed(funnel.video_url)
  const kt = takeaways.length
    ? `<h2>Key takeaways</h2><ul>${takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
    : ''

  const body = `
    ${logoTag(funnel)}
    <h1>${headline}</h1>
    ${sub}
    ${video}
    ${kt}
    <a class="btn" href="?page=book${subQuery(funnel)}">${cta}</a>`

  return shell(brand, tp.headline || 'Your training', body)
}

function bookPage(funnel: Record<string, any>, brand: Brand): string {
  const bp = (funnel.booking_page || {}) as Record<string, any>
  const headline = escapeHtml(bp.headline || 'Book your call')
  const sub = bp.subheadline ? `<p class="sub">${escapeHtml(bp.subheadline)}</p>` : `<p class="sub">Pick a time that works for you.</p>`
  const headshot = funnel.headshot_url ? `<img class="headshot" src="${escapeAttr(funnel.headshot_url)}" alt="" />` : ''

  const body = `
    ${logoTag(funnel)}
    ${headshot}
    <h1>${headline}</h1>
    ${sub}
    <div id="slots" class="card"><p class="muted">Loading available times…</p></div>
    <form id="bookform" class="card" style="display:none;margin-top:1rem;">
      <input type="hidden" id="slot_start" />
      <label for="b_first">First name</label><input id="b_first" required />
      <label for="b_last">Last name</label><input id="b_last" required />
      <label for="b_email">Email</label><input id="b_email" type="email" required />
      <button type="submit" id="bookbtn">Confirm booking</button>
      <div class="err" id="berr"></div>
    </form>
    <div id="done" style="display:none;" class="card"><h2>You're booked</h2><p class="muted" id="donemsg"></p></div>`

  const script = `
    var FUNNEL_ID = ${JSON.stringify(funnel.id)};
    var SUB = ${JSON.stringify(funnel.subdomain)};
    var slotsEl = document.getElementById('slots');
    var formEl = document.getElementById('bookform');
    function fmt(iso){ try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
    fetch('/api/calendar/availability').then(function(r){ return r.json(); }).then(function(j){
      var slots = (j && j.slots) || [];
      if (!slots.length) { slotsEl.innerHTML = '<p class="muted">No times available right now. Please check back soon.</p>'; return; }
      slotsEl.innerHTML = '<h2>Available times</h2>';
      slots.slice(0, 24).forEach(function(s){
        var b = document.createElement('button'); b.type='button'; b.className='slot'; b.textContent = fmt(s.start);
        b.addEventListener('click', function(){
          document.getElementById('slot_start').value = s.start;
          formEl.style.display = 'block';
          document.querySelectorAll('.slot').forEach(function(x){ x.style.outline='none'; });
          b.style.outline = '2px solid ' + ${JSON.stringify(brand.secondary)};
          formEl.scrollIntoView({ behavior:'smooth' });
        });
        slotsEl.appendChild(b);
      });
    }).catch(function(){ slotsEl.innerHTML = '<p class="err">Could not load times.</p>'; });
    formEl.addEventListener('submit', function(e){
      e.preventDefault();
      var btn = document.getElementById('bookbtn'); var err = document.getElementById('berr');
      err.textContent=''; btn.disabled = true;
      var body = { slot_start: document.getElementById('slot_start').value,
        first_name: document.getElementById('b_first').value, last_name: document.getElementById('b_last').value,
        email: document.getElementById('b_email').value };
      fetch('/api/calendar/book', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
        .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
        .then(function(res){
          if (!res.ok) { err.textContent = res.j && res.j.error ? res.j.error : 'Booking failed'; btn.disabled=false; return; }
          fetch('/api/funnel/event', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ funnel_id: FUNNEL_ID, subdomain: SUB, event_type: 'booked' }) }).catch(function(){});
          formEl.style.display='none'; slotsEl.style.display='none';
          document.getElementById('done').style.display='block';
          document.getElementById('donemsg').textContent = 'Your call is booked for ' + fmt(res.j.start_time) + '. Check your email for the details.';
        })
        .catch(function(){ err.textContent='Network error, please try again'; btn.disabled=false; });
    });`

  return shell(brand, bp.headline || 'Book your call', body, script)
}

function videoEmbed(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) {
    return `<div class="video"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;">Video coming soon</div></div>`
  }
  const u = url.trim()
  const yt = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/)
  if (yt) return `<div class="video"><iframe src="https://www.youtube.com/embed/${escapeAttr(yt[1])}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`
  const vim = u.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  if (vim) return `<div class="video"><iframe src="https://player.vimeo.com/video/${escapeAttr(vim[1])}" allowfullscreen allow="autoplay; fullscreen; picture-in-picture"></iframe></div>`
  // Direct file — a plain HTML5 player.
  return `<div class="video"><video src="${escapeAttr(u)}" controls playsinline></video></div>`
}

function bullets(v: unknown): string {
  if (!Array.isArray(v)) return ''
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => `<li>${escapeHtml(x)}</li>`)
    .join('')
}

// Preserve a ?subdomain= override across in-page navigation (testing before DNS).
function subQuery(funnel: Record<string, any>): string {
  return funnel.subdomain ? `&amp;subdomain=${escapeAttr(funnel.subdomain)}` : ''
}

function send404(res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.status(404).send('<!DOCTYPE html><html><body><h1>404</h1><p>Funnel not found</p></body></html>')
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function escapeAttr(s: unknown): string {
  return escapeHtml(s)
}
