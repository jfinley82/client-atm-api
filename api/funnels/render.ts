import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { sanitizeBrandColor, sanitizeBrandFont, sanitizeTracking, Tracking, DEFAULT_BRAND_PRIMARY, DEFAULT_BRAND_SECONDARY } from '../../lib/funnels'
import { loadBusinessSettings, isValidHttpUrl, BusinessSettings, Legal } from '../../lib/businessSettings'

// PUBLIC — no auth. Resolves a LIVE funnel from the request's subdomain and
// serves its real pages, routed by ?page= (landing | training | book; default
// landing).
//
// Brand identity, tracking pixels, and legal come from the funnel OWNER's
// ACCOUNT-LEVEL business settings (funnel_business_settings), NOT the funnel row
// — those per-funnel columns are vestigial now. The funnel row provides only
// this funnel's CONTENT (copy, video, subdomain, opt-in field choices). The
// headshot falls back to the owner's profile avatar when no override is set.
//
// Page views are logged to funnel_events (best-effort). Booking reuses the
// native calendar (/api/calendar/*): the book page passes funnel_id to
// /api/calendar/book, which logs 'booked' server-side.
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
    .select('id, user_id, subdomain, status, generation_id, video_url, collect_name, collect_phone, landing_page, training_page, booking_page')
    .eq('subdomain', subdomain)
    .maybeSingle()

  if (error) {
    console.error('[funnels/render]', error)
    return res.status(500).json({ error: 'Failed to render funnel' })
  }
  if (!funnel || funnel.status !== 'live') return send404(res)

  // Account-level branding/tracking/legal from the funnel owner, plus the owner's
  // profile name/avatar for the business-name + headshot fallbacks.
  const [settings, ownerRes] = await Promise.all([
    loadBusinessSettings(funnel.user_id as string),
    supabase.from('users').select('name, avatar_url').eq('id', funnel.user_id).maybeSingle(),
  ])
  const owner = (ownerRes.data || {}) as { name?: string | null; avatar_url?: string | null }

  const brand = brandKit(settings)
  const branding: Branding = {
    brand,
    head: trackingHead(sanitizeTracking(settings.tracking)),
    logoUrl: settings.logo_url,
    headshotUrl: settings.headshot_url || owner.avatar_url || null,
    businessName: settings.business_name || (owner.name ? owner.name.trim() : null) || null,
    legal: settings.legal || {},
  }

  // Best-effort page-view event. landing_view / training_view; the book page is
  // reached by clicking the "book a call" CTA, so its load is a booking_click.
  const viewEvent = page === 'training' ? 'training_view' : page === 'book' ? 'booking_click' : 'landing_view'
  logEvent(funnel.id, viewEvent)

  let html: string
  if (page === 'training') html = trainingPage(funnel, branding, await loadKeyTakeaways(funnel.generation_id))
  else if (page === 'book') html = bookPage(funnel, branding)
  else html = landingPage(funnel, branding)

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
  void supabase
    .from('funnel_events')
    .insert({ funnel_id: funnelId, event_type: eventType })
    .then(({ error }) => {
      if (error) console.error('[funnels/render] logEvent', eventType, error)
    })
}

// ---- rendering ----------------------------------------------------------

type Brand = { primary: string; secondary: string; isDark: boolean; text: string; bg: string; muted: string; card: string; font: string }
type Branding = { brand: Brand; head: string; logoUrl: string | null; headshotUrl: string | null; businessName: string | null; legal: Legal }

function brandKit(settings: BusinessSettings): Brand {
  // Sanitize on read — every value is emitted into <style>/<script>, so it must
  // be a validated color / allowlisted font or fall back to a safe default.
  const primary = sanitizeBrandColor(settings.brand_primary_color, DEFAULT_BRAND_PRIMARY)
  const secondary = sanitizeBrandColor(settings.brand_secondary_color, DEFAULT_BRAND_SECONDARY)
  const isDark = settings.theme_mode !== 'light'
  const font = sanitizeBrandFont(settings.brand_font)
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

// Ad-pixel <head> injection. Every interpolated ID comes from sanitizeTracking,
// so it matches a strict prefix + [A-Z0-9]/digits charset with no quote, angle
// bracket, or slash — it cannot break out of the single-quoted strings below.
function trackingHead(t: Tracking): string {
  let out = ''
  if (t.google_tag_id) {
    out += `<script async src="https://www.googletagmanager.com/gtag/js?id=${t.google_tag_id}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${t.google_tag_id}');</script>`
  }
  if (t.gtm_id) {
    out += `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${t.gtm_id}');</script>`
  }
  if (t.fb_pixel_id) {
    out += `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${t.fb_pixel_id}');fbq('track','PageView');</script>`
  }
  return out
}

const PIXEL_EVENT_JS = `
    function fbTrack(ev){ try { if (window.fbq) fbq('track', ev); } catch(e){} }
    function gaEvent(ev){ try { if (window.gtag) gtag('event', ev); } catch(e){} }`

// Compliance footer: business name + privacy/terms/contact links (only those
// set) + the coach's custom disclaimer (plain escaped text, no inline HTML) +
// the cookie note. A privacy link + disclaimer are effectively required to run
// FB/Google ads, so this is a compliance requirement.
function footer(brand: Brand, businessName: string | null, legal: Legal): string {
  const links: string[] = []
  // Sanitize on read — re-validate each legal URL is http(s) before emitting it
  // into an href, so a tampered or pre-validation value can't render a
  // javascript: link. Same defense-in-depth the brand fields use.
  const link = (url: string | undefined, label: string) =>
    url && isValidHttpUrl(url) ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : ''
  const p = link(legal.privacy_url, 'Privacy')
  const t = link(legal.terms_url, 'Terms')
  const c = link(legal.contact_url, 'Contact')
  for (const l of [p, t, c]) if (l) links.push(l)

  const parts: string[] = []
  if (businessName) parts.push(`<div class="foot-biz">${escapeHtml(businessName)}</div>`)
  if (links.length) parts.push(`<div class="foot-links">${links.join(' · ')}</div>`)
  if (legal.disclaimer) parts.push(`<div class="foot-disc">${escapeHtml(legal.disclaimer)}</div>`)
  parts.push(
    `<div class="foot-cookie">This page uses cookies and analytics to measure traffic and improve the experience. By continuing to browse, you consent to this use.</div>`
  )
  return `<footer class="site-footer">${parts.join('')}</footer>`
}

function shell(brand: Brand, title: string, body: string, script = '', head = '', footerHtml = ''): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="${brand.isDark ? 'dark' : 'light'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${head}
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
    .site-footer { max-width: 720px; margin: 0 auto; padding: 1.5rem 1.25rem 2.5rem; font-size: .72rem; color: ${brand.muted}; border-top: 1px solid ${brand.isDark ? 'rgba(255,255,255,.1)' : 'rgba(2,12,49,.1)'}; }
    .site-footer > div { margin-top: .4rem; }
    .foot-biz { font-weight: 600; }
    .site-footer a { color: ${brand.muted}; }
  </style>
</head>
<body>
  <main class="wrap">
    ${body}
  </main>
  ${footerHtml}
  ${script ? `<script>${script}</script>` : ''}
</body>
</html>`
}

// Only emit an <img> when a non-empty URL resolves — a coach with no logo /
// null avatar + no headshot override renders cleanly with no broken image.
function imgTag(url: string | null, cls: string): string {
  return url ? `<img class="${cls}" src="${escapeAttr(url)}" alt="" />` : ''
}

function landingPage(funnel: Record<string, any>, b: Branding): string {
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
    ${imgTag(b.logoUrl, 'logo')}
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

  const script = `${PIXEL_EVENT_JS}
    var FUNNEL_ID = ${JSON.stringify(funnel.id)};
    var SUB = ${JSON.stringify(funnel.subdomain)};
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
          fbTrack('Lead'); gaEvent('generate_lead');
          var u = new URL(window.location.href);
          u.searchParams.set('page', res.j && res.j.next ? res.j.next : 'training');
          // Carry the signed watch token to the training page so the video
          // player can attribute milestone beacons back to this lead.
          if (res.j && res.j.watch_token) u.searchParams.set('wt', res.j.watch_token);
          window.location.href = u.toString();
        })
        .catch(function(){ err.textContent = 'Network error, please try again'; btn.disabled = false; });
    });`

  return shell(b.brand, lp.headline || 'Free training', body, script, b.head, footer(b.brand, b.businessName, b.legal))
}

function trainingPage(funnel: Record<string, any>, b: Branding, takeaways: string[]): string {
  const tp = (funnel.training_page || {}) as Record<string, any>
  const headline = escapeHtml(tp.headline || 'Your training')
  const sub = tp.subheadline ? `<p class="sub">${escapeHtml(tp.subheadline)}</p>` : ''
  const cta = escapeHtml(tp.cta_label || 'Book a call')
  const video = videoEmbed(funnel.video_url)
  const kt = takeaways.length
    ? `<h2>Key takeaways</h2><ul>${takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
    : ''

  const body = `
    ${imgTag(b.logoUrl, 'logo')}
    <h1>${headline}</h1>
    ${sub}
    ${video.html}
    ${kt}
    <a class="btn" href="?page=book${subQuery(funnel)}">${cta}</a>`

  // Only wire the watch-tracking player when there is a real video to track.
  const script = video.init ? buildPlayerScript(funnel, video.init) : ''
  return shell(b.brand, tp.headline || 'Your training', body, script, b.head, footer(b.brand, b.businessName, b.legal))
}

// Per-page player harness: one random session id, the watch token the training
// page received from the opt-in (read client-side from ?wt=, never server HTML),
// and a beacon fired once per milestone via sendBeacon so it survives the
// navigation to the book page. Provider-specific `init` wires the progress calls.
function buildPlayerScript(funnel: Record<string, any>, init: string): string {
  return `(function(){
    var FUNNEL_ID = ${JSON.stringify(funnel.id)};
    var SUB = ${JSON.stringify(funnel.subdomain)};
    var SID = (function(){ try { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('s'+Date.now()+Math.random().toString(16).slice(2)); } catch(e){ return 's'+Date.now(); } })();
    var WT = (function(){ try { return new URLSearchParams(window.location.search).get('wt') || ''; } catch(e){ return ''; } })();
    var fired = {};
    function beacon(pct){
      if (fired[pct]) return; fired[pct] = true;
      var payload = { funnel_id: FUNNEL_ID, subdomain: SUB, event_type: pct >= 100 ? 'video_completed' : 'video_watched', session_id: SID, percent: pct };
      if (WT) payload.watch_token = WT;
      var s = JSON.stringify(payload);
      try { if (navigator.sendBeacon) { navigator.sendBeacon('/api/funnel/event', new Blob([s], { type: 'application/json' })); return; } } catch(e){}
      try { fetch('/api/funnel/event', { method:'POST', headers:{'Content-Type':'application/json'}, body: s, keepalive: true }); } catch(e){}
    }
    function onProgress(pct){
      if (pct >= 25) beacon(25);
      if (pct >= 50) beacon(50);
      if (pct >= 75) beacon(75);
      if (pct >= 100) beacon(100);
    }
    ${init}
  })();`
}

function bookPage(funnel: Record<string, any>, b: Branding): string {
  const bp = (funnel.booking_page || {}) as Record<string, any>
  const headline = escapeHtml(bp.headline || 'Book your call')
  const sub = bp.subheadline ? `<p class="sub">${escapeHtml(bp.subheadline)}</p>` : `<p class="sub">Pick a time that works for you.</p>`

  const body = `
    ${imgTag(b.logoUrl, 'logo')}
    ${imgTag(b.headshotUrl, 'headshot')}
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

  const script = `${PIXEL_EVENT_JS}
    var FUNNEL_ID = ${JSON.stringify(funnel.id)};
    var slotsEl = document.getElementById('slots');
    var formEl = document.getElementById('bookform');
    function fmt(iso){ try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
    fetch('/api/calendar/availability').then(function(r){ return r.json(); }).then(function(j){
      var slots = (j && j.slots) || [];
      if (!slots.length) { slotsEl.innerHTML = '<p class="muted">No times available right now. Please check back soon.</p>'; return; }
      slotsEl.innerHTML = '<h2>Available times</h2>';
      slots.slice(0, 24).forEach(function(s){
        var bn = document.createElement('button'); bn.type='button'; bn.className='slot'; bn.textContent = fmt(s.start);
        bn.addEventListener('click', function(){
          document.getElementById('slot_start').value = s.start;
          formEl.style.display = 'block';
          document.querySelectorAll('.slot').forEach(function(x){ x.style.outline='none'; });
          bn.style.outline = '2px solid ' + ${JSON.stringify(b.brand.secondary)};
          formEl.scrollIntoView({ behavior:'smooth' });
        });
        slotsEl.appendChild(bn);
      });
    }).catch(function(){ slotsEl.innerHTML = '<p class="err">Could not load times.</p>'; });
    formEl.addEventListener('submit', function(e){
      e.preventDefault();
      var btn = document.getElementById('bookbtn'); var err = document.getElementById('berr');
      err.textContent=''; btn.disabled = true;
      var body = { slot_start: document.getElementById('slot_start').value,
        first_name: document.getElementById('b_first').value, last_name: document.getElementById('b_last').value,
        email: document.getElementById('b_email').value, funnel_id: FUNNEL_ID };
      fetch('/api/calendar/book', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
        .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
        .then(function(res){
          if (!res.ok) { err.textContent = res.j && res.j.error ? res.j.error : 'Booking failed'; btn.disabled=false; return; }
          fbTrack('Schedule'); gaEvent('schedule');
          formEl.style.display='none'; slotsEl.style.display='none';
          document.getElementById('done').style.display='block';
          document.getElementById('donemsg').textContent = 'Your call is booked for ' + fmt(res.j.start_time) + '. Check your email for the details.';
        })
        .catch(function(){ err.textContent='Network error, please try again'; btn.disabled=false; });
    });`

  return shell(b.brand, bp.headline || 'Book your call', body, script, b.head, footer(b.brand, b.businessName, b.legal))
}

// Returns the player markup plus the provider-specific tracking `init` JS that
// calls onProgress(percent)/onProgress(100) (defined by buildPlayerScript). The
// video id is the ONLY interpolated value and is escapeAttr'd into the src; the
// init strings are static. Only the official YouTube / Vimeo SDKs are loaded.
function videoEmbed(url: unknown): { html: string; init: string } {
  if (typeof url !== 'string' || !url.trim()) {
    return {
      html: `<div class="video"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;">Video coming soon</div></div>`,
      init: '',
    }
  }
  const u = url.trim()

  const yt = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/)
  if (yt) {
    return {
      html: `<div class="video"><iframe id="mtm-video" src="https://www.youtube.com/embed/${escapeAttr(yt[1])}?enablejsapi=1" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`,
      init: YT_INIT,
    }
  }

  const vim = u.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  if (vim) {
    return {
      html: `<div class="video"><iframe id="mtm-video" src="https://player.vimeo.com/video/${escapeAttr(vim[1])}" allowfullscreen allow="autoplay; fullscreen; picture-in-picture"></iframe></div>`,
      init: VIMEO_INIT,
    }
  }

  return {
    html: `<div class="video"><video id="mtm-video" src="${escapeAttr(u)}" controls playsinline></video></div>`,
    init: DIRECT_INIT,
  }
}

// Native <video>: timeupdate for the 25/50/75 milestones, ended for completion.
const DIRECT_INIT = `
    var v = document.getElementById('mtm-video');
    if (v) {
      v.addEventListener('timeupdate', function(){ if (v.duration > 0) onProgress(Math.floor(v.currentTime / v.duration * 100)); });
      v.addEventListener('ended', function(){ onProgress(100); });
    }`

// YouTube IFrame API (official domain): poll getCurrentTime/getDuration while
// playing; the ENDED state is completion.
const YT_INIT = `
    var ytPoll;
    window.onYouTubeIframeAPIReady = function(){
      try {
        var p = new YT.Player('mtm-video', { events: {
          onStateChange: function(e){
            if (e.data === YT.PlayerState.PLAYING && !ytPoll) {
              ytPoll = setInterval(function(){
                try { var d = p.getDuration(), t = p.getCurrentTime(); if (d > 0) onProgress(Math.floor(t / d * 100)); } catch(_){}
              }, 1000);
            }
            if (e.data === YT.PlayerState.ENDED) onProgress(100);
          }
        }});
      } catch(_){}
    };
    var yts = document.createElement('script'); yts.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(yts);`

// Vimeo Player SDK (official domain): its timeupdate gives a 0..1 percent, ended
// is completion.
const VIMEO_INIT = `
    var vms = document.createElement('script'); vms.src = 'https://player.vimeo.com/api/player.js';
    vms.onload = function(){
      try {
        var pl = new Vimeo.Player('mtm-video');
        pl.on('timeupdate', function(data){ if (data && typeof data.percent === 'number') onProgress(Math.floor(data.percent * 100)); });
        pl.on('ended', function(){ onProgress(100); });
      } catch(_){}
    };
    document.head.appendChild(vms);`

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
