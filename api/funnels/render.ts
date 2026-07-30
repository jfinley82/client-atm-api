import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

const FUNNEL_PUBLIC_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'
import { sanitizeBrandColor, sanitizeBrandFont, sanitizeTracking, Tracking, DEFAULT_BRAND_PRIMARY, DEFAULT_BRAND_SECONDARY } from '../../lib/funnels'
import { loadBusinessSettings, isValidHttpUrl, BusinessSettings, Legal } from '../../lib/businessSettings'
import { funnelBookingQuestions, BookingQuestion } from '../../lib/bookingQuestions'
import { gateApplies } from '../../lib/applicationGate'

// PUBLIC — no auth. Resolves a LIVE funnel from the request's subdomain and
// serves its real pages, routed by ?page= (landing | training | book; default
// landing).
//
// Tracking pixels and legal come from the funnel OWNER's ACCOUNT-LEVEL business
// settings (funnel_business_settings). Brand identity is now a PER-FUNNEL
// override with the account-level value as the fallback: the workspace Settings
// tab writes colors / fonts / logo / headshot onto the funnel row, and a funnel
// that has never been edited there holds NULLs and renders exactly as it did
// when those columns were vestigial. The headshot chain ends at the owner's
// profile avatar.
//
// ?page=book renders in ONE step normally, and in TWO when the funnel's
// application gate is on — see bookPage().
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
  // privacy/terms arrive as ?page= too — vercel.json rewrites /privacy and /terms
  // on the funnel domain to this handler with the page already set, rather than
  // relying on the post-rewrite request path.
  const page = ['landing', 'training', 'book', 'privacy', 'terms'].includes(String(pageParam)) ? String(pageParam) : 'landing'

  if (!subdomain) return send404(res)

  const { data: funnel, error } = await supabase
    .from('funnels')
    // Content, then the application-gate columns (migration 063) that decide
    // whether ?page=book renders in one step or two, then the per-funnel brand
    // overrides + legal toggle the Settings tab writes.
    //
    // Kept as ONE string literal on purpose: supabase-js infers the row type from
    // the select text, and a concatenated expression widens to `string`, which
    // collapses `data` to an error type and breaks every field access below.
    .select('id, user_id, subdomain, status, generation_id, video_url, collect_name, collect_phone, landing_page, training_page, booking_page, application_questions_enabled, booking_questions, disqualify_rules, disqualify_action, disqualify_message, disqualify_redirect_url, logo_url, headshot_url, brand_primary_color, brand_secondary_color, brand_font, brand_headline_font, brand_body_font, cookie_notice_enabled, cta_mode, offer_url, offer_button_text, offer_price_display, legal_privacy, legal_terms')
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

  const brand = brandKit(settings, funnel)
  // Per-funnel logo/headshot (the Settings tab's fields) take precedence over the
  // account-level ones, which in turn fall back to the owner's profile avatar.
  const branding: Branding = {
    brand,
    head: trackingHead(sanitizeTracking(settings.tracking)),
    logoUrl: firstUrl(funnel.logo_url, settings.logo_url),
    headshotUrl: firstUrl(funnel.headshot_url, settings.headshot_url, owner.avatar_url),
    businessName: settings.business_name || (owner.name ? owner.name.trim() : null) || null,
    // Hosted legal wins over the account-level link: if the coach wrote the
    // policy here, the footer should point at the copy this domain actually
    // serves, not at whatever they linked before.
    legal: withHostedLegal(settings.legal || {}, funnel),
    // Legal toggle: only the explicit false switches the cookie notice off, so a
    // funnel predating the column (NULL) keeps rendering it exactly as before.
    cookieNotice: funnel.cookie_notice_enabled !== false,
  }

  // The hosted legal pages are served before anything else: they are not funnel
  // steps, so they log no view event and take no part in the sell-mode routing.
  if (page === 'privacy' || page === 'terms') {
    const legalHtml = legalPage(funnel, branding, page)
    if (!legalHtml) {
      // Nothing written here. Fall back to the account-level link the coach set
      // (their own hosted page) before giving up — a 404 on /privacy is a real
      // compliance problem for anyone running ads.
      const url = page === 'privacy' ? branding.legal.privacy_url : branding.legal.terms_url
      if (url && isValidHttpUrl(url)) {
        res.setHeader('Location', url)
        return res.status(302).end()
      }
      return send404(res)
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.status(200).send(legalHtml)
  }

  // Best-effort page-view event. landing_view / training_view; the book page is
  // reached by clicking the "book a call" CTA, so its load is a booking_click.
  const viewEvent = page === 'training' ? 'training_view' : page === 'book' ? 'booking_click' : 'landing_view'
  logEvent(funnel.id, viewEvent)

  // Sell mode has no calendar, so ?page=book has nothing to render — a lead who
  // reaches it from an old link or a bookmark goes back to the training page,
  // where the offer CTA is. Redirecting rather than rendering an empty booking
  // page is what makes "no calendar in sell mode" true of every route, not just
  // of the CTA.
  if (page === 'book' && sellMode(funnel)) {
    res.setHeader('Location', `?page=training${funnel.subdomain ? `&subdomain=${encodeURIComponent(funnel.subdomain as string)}` : ''}`)
    return res.status(302).end()
  }

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

type Brand = { primary: string; secondary: string; isDark: boolean; text: string; bg: string; muted: string; card: string; font: string; headlineFont: string }
type Branding = { brand: Brand; head: string; logoUrl: string | null; headshotUrl: string | null; businessName: string | null; legal: Legal; cookieNotice: boolean }

// First value that is a usable http(s) URL. Used for the logo/headshot precedence
// chain; re-validating here means a per-funnel value written before the URL check
// existed still can't render a javascript: src.
function firstUrl(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() && isValidHttpUrl(c.trim())) return c.trim()
  }
  return null
}

function brandKit(settings: BusinessSettings, funnel: Record<string, any>): Brand {
  // Per-funnel brand wins, account-level settings are the fallback. Every funnel
  // that predates the Settings tab has NULLs in these columns and therefore
  // renders byte-identically to before.
  //
  // Sanitize on read — every value is emitted into <style>/<script>, so it must
  // be a validated color / allowlisted font or fall back to a safe default.
  const pick = (a: unknown, b: unknown): unknown => (typeof a === 'string' && a.trim() ? a : b)
  const primary = sanitizeBrandColor(pick(funnel.brand_primary_color, settings.brand_primary_color), DEFAULT_BRAND_PRIMARY)
  const secondary = sanitizeBrandColor(pick(funnel.brand_secondary_color, settings.brand_secondary_color), DEFAULT_BRAND_SECONDARY)
  const isDark = settings.theme_mode !== 'light'
  // brand_body_font is the per-funnel body face; the older single brand_font (per
  // funnel, then per account) is what it supersedes. Headline defaults to the body
  // face, so setting only one still gives a coherent page.
  const font = sanitizeBrandFont(pick(funnel.brand_body_font, pick(funnel.brand_font, settings.brand_font)))
  const headlineFont = sanitizeBrandFont(pick(funnel.brand_headline_font, font))
  return {
    primary,
    secondary,
    isDark,
    font,
    headlineFont,
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
function footer(brand: Brand, businessName: string | null, legal: Legal, cookieNotice = true): string {
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
  if (cookieNotice) {
    parts.push(
      `<div class="foot-cookie">This page uses cookies and analytics to measure traffic and improve the experience. By continuing to browse, you consent to this use.</div>`
    )
  }
  return `<footer class="site-footer">${parts.join('')}</footer>`
}

// Every page renders the same footer from the same branding, so the cookie
// toggle can't end up honoured on one page and ignored on another.
function siteFooter(b: Branding): string {
  return footer(b.brand, b.businessName, b.legal, b.cookieNotice)
}

// ---- hosted legal (/privacy, /terms) ----------------------------------------

// Point the footer's Privacy/Terms links at this funnel's own hosted pages when
// the coach has written content for them, leaving the account-level link in
// place when they have not.
//
// Absolute rather than relative because footer() emits these with target=_blank
// after an http(s) check — the same read-side validation every other URL in the
// footer goes through, and a relative path could not pass it.
function withHostedLegal(legal: Legal, funnel: Record<string, any>): Legal {
  const sub = typeof funnel.subdomain === 'string' ? funnel.subdomain.trim() : ''
  if (!sub) return legal
  const base = `https://${sub}.${FUNNEL_PUBLIC_DOMAIN}`
  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  return {
    ...legal,
    ...(has(funnel.legal_privacy) ? { privacy_url: `${base}/privacy` } : {}),
    ...(has(funnel.legal_terms) ? { terms_url: `${base}/terms` } : {}),
  }
}

// Serves the coach's own privacy policy / terms on the funnel domain, from the
// text they wrote in Settings. Returns null when nothing is written, so the
// caller can fall back to their externally-hosted link.
//
// The stored value is PLAIN TEXT and is rendered escaped, split on blank lines
// into paragraphs. This is the whole reason the column is not HTML: it is
// owner-writable content on a public page, and parsing markup here would make it
// a stored-XSS vector for anyone who can edit a funnel.
function legalPage(funnel: Record<string, any>, b: Branding, kind: 'privacy' | 'terms'): string | null {
  const raw = kind === 'privacy' ? funnel.legal_privacy : funnel.legal_terms
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null

  const title = kind === 'privacy' ? 'Privacy Policy' : 'Terms of Service'
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    // Single newlines inside a paragraph stay as line breaks, which is how the
    // coach typed it — legal text is full of short enumerated lines.
    .map((p) => `<p class="legal-p">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('')

  const body = `
    ${imgTag(b.logoUrl, 'logo')}
    <h1>${escapeHtml(title)}</h1>
    ${b.businessName ? `<p class="sub">${escapeHtml(b.businessName)}</p>` : ''}
    ${paragraphs}`

  return shell(b.brand, title, body, '', b.head, siteFooter(b))
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
    h1, h2 { font-family: ${brand.headlineFont}; }
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
    .legal-p { color: ${brand.muted}; font-size: .95rem; margin: 0 0 1rem; white-space: normal; }
    /* Application gate (?page=book with the gate on): video beside the quiz on a
       wide screen, stacked on a phone. Inert on every other page. */
    .appgrid { display: grid; gap: 1.25rem; grid-template-columns: 1fr; }
    @media (min-width: 900px) { .wrap:has(.appgrid) { max-width: 1040px; } .appgrid { grid-template-columns: 1fr 1fr; align-items: start; } }
    .appvideo .video { margin-bottom: 0; }
    .appquiz { display: flex; flex-direction: column; }
    .qprog { font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; }
    .qlabel { font-family: ${brand.headlineFont}; font-size: 1.35rem; line-height: 1.25; margin: .5rem 0 1rem; }
    #qfield select, #qfield textarea, #qfield input {
      width: 100%; padding: .8rem .9rem; border-radius: 10px; font-size: 1rem; font-family: inherit;
      border: 1px solid ${brand.isDark ? 'rgba(255,255,255,.2)' : 'rgba(2,12,49,.2)'};
      background: ${brand.isDark ? 'rgba(255,255,255,.04)' : '#fff'}; color: ${brand.text};
    }
    .qchoices { display: flex; flex-direction: column; gap: .6rem; margin-bottom: .5rem; }
    .qchoice {
      width: 100%; text-align: left; padding: .85rem 1rem; border-radius: 10px; font-size: 1rem; cursor: pointer;
      border: 1px solid ${brand.isDark ? 'rgba(255,255,255,.2)' : 'rgba(2,12,49,.2)'};
      background: ${brand.isDark ? 'rgba(255,255,255,.04)' : '#fff'}; color: ${brand.text};
    }
    .qchoice.selected { border-color: ${brand.secondary}; border-width: 2px; }
    .qnav { display: flex; gap: .75rem; }
    .qnav button { flex: 1; }
    .qnav .ghost { background: transparent; color: ${brand.muted}; border: 1px solid ${brand.isDark ? 'rgba(255,255,255,.2)' : 'rgba(2,12,49,.2)'}; flex: 0 0 auto; padding-left: 1.4rem; padding-right: 1.4rem; }
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

  return shell(b.brand, lp.headline || 'Free training', body, script, b.head, siteFooter(b))
}

function trainingPage(funnel: Record<string, any>, b: Branding, takeaways: string[]): string {
  const tp = (funnel.training_page || {}) as Record<string, any>
  const headline = escapeWithLinks(tp.headline || 'Your training', funnel)
  const sub = tp.subheadline ? `<p class="sub">${escapeWithLinks(tp.subheadline, funnel)}</p>` : ''
  const video = videoEmbed(funnel.video_url)
  const kt = takeaways.length
    ? `<h2>Key takeaways</h2><ul>${takeaways.map((t) => `<li>${escapeWithLinks(t, funnel)}</li>`).join('')}</ul>`
    : ''

  // Sell mode: the CTA goes to the coach's offer instead of the calendar, with
  // the price under it when they set one. It routes through /api/funnel/offer so
  // the attribution token is minted and signed server-side — see that endpoint.
  //
  // The href is built here rather than pointing at offer_url directly, which is
  // also what keeps the "no calendar" promise honest: in sell mode nothing on
  // this page links to ?page=book at all.
  const cta = sellMode(funnel)
    ? `<a class="btn" href="${offerHref(funnel)}" id="offercta">${escapeHtml(funnel.offer_button_text || tp.cta_label || 'Get instant access')}</a>${
        typeof funnel.offer_price_display === 'string' && funnel.offer_price_display.trim()
          ? `<p class="muted" style="text-align:center;margin:.6rem 0 0;font-size:.9rem;">${escapeHtml(funnel.offer_price_display)}</p>`
          : ''
      }`
    : `<a class="btn" href="?page=book${subQuery(funnel)}">${escapeHtml(tp.cta_label || 'Book a call')}</a>`

  const body = `
    ${imgTag(b.logoUrl, 'logo')}
    <h1>${headline}</h1>
    ${sub}
    ${video.html}
    ${kt}
    ${cta}`

  // Only wire the watch-tracking player when there is a real video to track; the
  // token hand-off runs either way. In sell mode it also carries the token onto
  // the offer link, so the redirect can name the lead the sale belongs to.
  const script = [
    CARRY_WATCH_TOKEN_JS,
    sellMode(funnel) ? CARRY_OFFER_TOKEN_JS : '',
    video.init ? buildPlayerScript(funnel, video.init) : '',
  ]
    .filter(Boolean)
    .join('\n')
  return shell(b.brand, tp.headline || 'Your training', body, script, b.head, siteFooter(b))
}

// ---- sell mode ----------------------------------------------------------
// cta_mode = 'sell' sends the training CTA to the coach's offer instead of the
// calendar. An offer URL is required to save sell mode (the Settings endpoint
// rejects it otherwise), but this re-checks rather than trusting it: a row
// edited directly, or one whose offer URL was later cleared, must fall back to
// the booking CTA rather than render a button that goes nowhere.
function sellMode(funnel: Record<string, any>): boolean {
  return funnel.cta_mode === 'sell' && typeof funnel.offer_url === 'string' && isValidHttpUrl(funnel.offer_url.trim())
}

// Relative, so the ?subdomain= preview keeps working, and /api/ is excluded from
// the funnel-domain rewrite so it reaches the real function.
function offerHref(funnel: Record<string, any>): string {
  const sub = typeof funnel.subdomain === 'string' ? funnel.subdomain : ''
  return `/api/funnel/offer?funnel_id=${escapeAttr(funnel.id)}${sub ? `&amp;subdomain=${escapeAttr(sub)}` : ''}`
}

// Same hand-off as the booking link, for the offer redirect: without the token
// the redirect cannot tell which lead clicked, and the sale it later records
// would have no one to attribute to.
const CARRY_OFFER_TOKEN_JS = `(function(){
    try {
      var wt = new URLSearchParams(window.location.search).get('wt');
      var a = document.getElementById('offercta');
      if (!wt || !a) return;
      var u = new URL(a.getAttribute('href'), window.location.href);
      u.searchParams.set('wt', wt);
      a.setAttribute('href', u.pathname + u.search);
    } catch(e){}
  })();`

// Carry the watch token from the training page's URL onto every link into the
// booking page (the CTA button and any [BOOK_A_CALL_LINK] the copy contains).
//
// The token is what lets the booking page greet an already-opted-in lead by name
// instead of asking for details they gave at the opt-in — the whole reason step 2
// of the application gate collects no name or email. It stays client-side and out
// of the server HTML, exactly as the video beacons already treat it.
const CARRY_WATCH_TOKEN_JS = `(function(){
    try {
      var wt = new URLSearchParams(window.location.search).get('wt');
      if (!wt) return;
      var links = document.querySelectorAll('a[href*="page=book"]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        if (!href) continue;
        var u = new URL(href, window.location.href);
        u.searchParams.set('wt', wt);
        // Keep it relative — an absolute href would break the ?subdomain= preview.
        links[i].setAttribute('href', u.pathname + u.search);
      }
    } catch(e){}
  })();`

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

// ?page=book — one step normally, TWO when the funnel's application gate is on.
//
// The gate is the launch-critical distinction: with it on, the lead first answers
// the coach's application questions and the calendar is not in the served HTML at
// all. Only a submission that passes the funnel's disqualify_rules causes step 2
// to be built. That is a rendering decision, not the enforcement — a disqualified
// lead is kept out of the bookings table by checkGate() inside /api/calendar/book,
// which this page cannot bypass.
function bookPage(funnel: Record<string, any>, b: Branding): string {
  const questions = funnelBookingQuestions(funnel)
  return gateApplies(funnel, questions)
    ? gatedBookPage(funnel, b, questions)
    : classicBookPage(funnel, b)
}

// Shared booking mechanics: render the slot list, confirm the pick, show the
// done state. Both the classic page and step 2 of the gated page drive the SAME
// element ids through this, so the two flows can't drift into two behaviours.
//
// initBooking(opts):
//   opts.lead    — { name, email } for an already-identified lead; step 2 then
//                  has no name/email inputs and books with these values.
//   opts.answers — the application answers, posted with the booking so the
//                  server can re-run the gate on exactly what the lead submitted.
const BOOKING_JS = `
    function fmt(iso){ try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
    function initBooking(opts){
      var slotsEl = document.getElementById('slots');
      var formEl = document.getElementById('bookform');
      if (!slotsEl || !formEl) return;
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
            bn.style.outline = '2px solid ' + BRAND_SECONDARY;
            formEl.scrollIntoView({ behavior:'smooth' });
          });
          slotsEl.appendChild(bn);
        });
      }).catch(function(){ slotsEl.innerHTML = '<p class="err">Could not load times.</p>'; });
      formEl.addEventListener('submit', function(e){
        e.preventDefault();
        var btn = document.getElementById('bookbtn'); var err = document.getElementById('berr');
        err.textContent=''; btn.disabled = true;
        var first = document.getElementById('b_first'), last = document.getElementById('b_last'), mail = document.getElementById('b_email');
        var body = { slot_start: document.getElementById('slot_start').value, funnel_id: FUNNEL_ID };
        if (opts.lead) {
          // The lead opted in already — reuse what they gave then. last_name may be
          // empty, which /api/calendar/book accepts as long as a name is present.
          body.first_name = opts.lead.name || opts.lead.email; body.last_name = ''; body.email = opts.lead.email;
        } else {
          body.first_name = first ? first.value : ''; body.last_name = last ? last.value : ''; body.email = mail ? mail.value : '';
        }
        if (opts.answers) body.answers = opts.answers;
        fetch('/api/calendar/book', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
          .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
          .then(function(res){
            if (!res.ok) {
              // The server re-ran the gate and said no. Never leave the lead on a
              // calendar they can't book — show the funnel's own not-a-fit screen.
              if (res.j && res.j.error === 'disqualified' && typeof showBlocked === 'function') { showBlocked(res.j); return; }
              err.textContent = (res.j && (res.j.message || res.j.error)) || 'Booking failed'; btn.disabled=false; return;
            }
            fbTrack('Schedule'); gaEvent('schedule');
            formEl.style.display='none'; slotsEl.style.display='none';
            var greet = document.getElementById('bookingas'); if (greet) greet.style.display='none';
            document.getElementById('done').style.display='block';
            document.getElementById('donemsg').textContent = 'Your call is booked for ' + fmt(res.j.start_time) + '. Check your email for the details.';
          })
          .catch(function(){ err.textContent='Network error, please try again'; btn.disabled=false; });
      });
    }`

// The booking form markup, shared by both flows. `identified` drops the name and
// email inputs — an opted-in lead has already given both.
function bookingFormHtml(identified: boolean): string {
  const fields = identified
    ? ''
    : `<label for="b_first">First name</label><input id="b_first" required />
      <label for="b_last">Last name</label><input id="b_last" required />
      <label for="b_email">Email</label><input id="b_email" type="email" required />`
  return `<form id="bookform" class="card" style="display:none;margin-top:1rem;">
      <input type="hidden" id="slot_start" />
      ${fields}
      <button type="submit" id="bookbtn">Confirm booking</button>
      <div class="err" id="berr"></div>
    </form>
    <div id="done" style="display:none;" class="card"><h2>You're booked</h2><p class="muted" id="donemsg"></p></div>`
}

// Today's single-step page, unchanged in behaviour: the calendar loads on arrival
// and the form collects name + email.
function classicBookPage(funnel: Record<string, any>, b: Branding): string {
  const bp = (funnel.booking_page || {}) as Record<string, any>
  const headline = escapeHtml(bp.headline || 'Book your call')
  const sub = bp.subheadline ? `<p class="sub">${escapeHtml(bp.subheadline)}</p>` : `<p class="sub">Pick a time that works for you.</p>`

  const body = `
    ${imgTag(b.logoUrl, 'logo')}
    ${imgTag(b.headshotUrl, 'headshot')}
    <h1>${headline}</h1>
    ${sub}
    <div id="slots" class="card"><p class="muted">Loading available times…</p></div>
    ${bookingFormHtml(false)}`

  const script = `${PIXEL_EVENT_JS}
    var FUNNEL_ID = ${JSON.stringify(funnel.id)};
    var BRAND_SECONDARY = ${JSON.stringify(b.brand.secondary)};
    ${BOOKING_JS}
    initBooking({ lead: null, answers: null });`

  return shell(b.brand, bp.headline || 'Book your call', body, script, b.head, siteFooter(b))
}

// Step 1: the application video plus the questions as a one-at-a-time quiz.
// Step 2 (the calendar) is BUILT BY SCRIPT after a passing submission — the
// served HTML contains an empty <div id="step2">, no slot list, no availability
// request, and nothing a lead could unhide to reach the calendar early.
function gatedBookPage(funnel: Record<string, any>, b: Branding, questions: BookingQuestion[]): string {
  const bp = (funnel.booking_page || {}) as Record<string, any>
  const headline = escapeHtml(bp.headline || 'Apply for your call')
  const sub = bp.subheadline
    ? `<p class="sub">${escapeHtml(bp.subheadline)}</p>`
    : `<p class="sub">Answer a few quick questions to see if this is a fit.</p>`

  // The application video is the booking page's own when set, otherwise the
  // funnel's. No watch beacons here — this page tracks the application, not a view.
  const video = videoEmbed(typeof bp.video_url === 'string' && bp.video_url.trim() ? bp.video_url : funnel.video_url)

  const body = `
    ${imgTag(b.logoUrl, 'logo')}
    <h1>${headline}</h1>
    ${sub}
    <div id="step1" class="appgrid">
      <div class="appvideo">${video.html}</div>
      <div class="card appquiz">
        <div class="qprog muted" id="qprog"></div>
        <div class="qlabel" id="qlabel"></div>
        <div id="qfield"></div>
        <div class="qnav">
          <button type="button" id="qback" class="ghost">Back</button>
          <button type="button" id="qnext">Next</button>
        </div>
        <div class="err" id="qerr"></div>
      </div>
    </div>
    <div id="step2" style="display:none;"></div>
    <div id="blocked" style="display:none;" class="card"></div>`

  const script = `${PIXEL_EVENT_JS}
    var FUNNEL_ID = ${JSON.stringify(funnel.id)};
    var BRAND_SECONDARY = ${JSON.stringify(b.brand.secondary)};
    var QUESTIONS = ${jsonForScript(questions)};
    var HEADSHOT = ${jsonForScript(b.headshotUrl)};
    // Read client-side only, exactly as the training page's beacons do.
    var WT = (function(){ try { return new URLSearchParams(window.location.search).get('wt') || ''; } catch(e){ return ''; } })();
    var answers = {};
    var idx = 0;
    var submitting = false;
    ${BOOKING_JS}

    function api(payload, onDone, onFail){
      payload.funnel_id = FUNNEL_ID; if (WT) payload.watch_token = WT;
      fetch('/api/funnel/application', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
        .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
        .then(function(res){ if (res.ok) onDone(res.j); else if (onFail) onFail(res.j); })
        .catch(function(){ if (onFail) onFail(null); });
    }

    function currentValue(){
      var el = document.getElementById('qinput');
      return el ? String(el.value || '').trim() : '';
    }

    // Build the field for question i. Labels and options are the coach's own text,
    // set as textContent so a question can never inject markup into a lead's page.
    function renderQ(){
      var q = QUESTIONS[idx];
      document.getElementById('qprog').textContent = 'Question ' + (idx + 1) + ' of ' + QUESTIONS.length;
      document.getElementById('qlabel').textContent = q.label + (q.required ? ' *' : '');
      var host = document.getElementById('qfield');
      host.innerHTML = '';
      var el;
      if (q.type === 'choice') {
        // Typeform-style tappable options rather than a native <select> — the
        // hidden input is what currentValue()/next() already read, so the quiz's
        // nav (Back/Next, required check, answer restore on Back) needs no
        // separate path for this type.
        el = document.createElement('input'); el.type = 'hidden';
        var group = document.createElement('div'); group.className = 'qchoices';
        (q.options || []).forEach(function(o){
          var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'qchoice'; btn.textContent = o;
          if (answers[q.id] === o) btn.classList.add('selected');
          btn.addEventListener('click', function(){
            el.value = o;
            group.querySelectorAll('.qchoice').forEach(function(b){ b.classList.remove('selected'); });
            btn.classList.add('selected');
            next();
          });
          group.appendChild(btn);
        });
        host.appendChild(group);
      } else if (q.type === 'dropdown') {
        el = document.createElement('select');
        var blank = document.createElement('option'); blank.value=''; blank.textContent='Choose one…'; el.appendChild(blank);
        (q.options || []).forEach(function(o){ var op = document.createElement('option'); op.value=o; op.textContent=o; el.appendChild(op); });
      } else if (q.type === 'multi_line') {
        el = document.createElement('textarea'); el.rows = 4;
      } else {
        el = document.createElement('input'); el.type = 'text';
      }
      el.id = 'qinput';
      if (answers[q.id]) el.value = answers[q.id];
      host.appendChild(el);
      if (q.type !== 'choice') el.focus();
      document.getElementById('qback').style.visibility = idx === 0 ? 'hidden' : 'visible';
      document.getElementById('qnext').textContent = idx === QUESTIONS.length - 1 ? 'Submit application' : 'Next';
      document.getElementById('qerr').textContent = '';
    }

    function next(){
      if (submitting) return;
      var q = QUESTIONS[idx];
      var val = currentValue();
      if (q.required && !val) { document.getElementById('qerr').textContent = 'Please answer this to continue.'; return; }
      answers[q.id] = val;
      if (idx < QUESTIONS.length - 1) { idx++; renderQ(); return; }
      submit();
    }

    function submit(){
      submitting = true;
      var btn = document.getElementById('qnext'); btn.disabled = true; btn.textContent = 'Submitting…';
      api({ action:'submit', answers: answers }, function(j){
        if (j && j.qualified === false) { showBlocked(j); return; }
        showStep2(j && j.lead ? j.lead : null);
      }, function(j){
        submitting = false; btn.disabled = false; btn.textContent = 'Submit application';
        document.getElementById('qerr').textContent = (j && (j.message || j.error)) || 'Something went wrong, please try again.';
      });
    }

    // Not a fit. The calendar is never built, so there is nothing to hide.
    function showBlocked(j){
      document.getElementById('step1').style.display = 'none';
      document.getElementById('step2').style.display = 'none';
      var el = document.getElementById('blocked');
      el.innerHTML = '';
      var h = document.createElement('h2'); h.textContent = 'Thanks for applying'; el.appendChild(h);
      var p = document.createElement('p'); p.className = 'muted';
      p.textContent = (j && j.message) || "Thanks for your interest — this isn't the right fit right now.";
      el.appendChild(p);
      var action = j && j.action;
      var url = j && j.redirect_url;
      if ((action === 'resource' || action === 'redirect') && url) {
        var a = document.createElement('a'); a.className = 'btn'; a.href = url; a.rel = 'noopener noreferrer';
        a.textContent = action === 'resource' ? 'Get the resource' : 'Continue';
        el.appendChild(a);
        // 'redirect' means send them onward; the delay is so the coach's message is
        // actually read first. 'resource' just offers the link.
        if (action === 'redirect') setTimeout(function(){ window.location.href = url; }, 2500);
      }
      // 'ai_assistant' is accepted and stored, but its shell is not built yet, so
      // it deliberately renders the plain message above and nothing more. Wiring
      // the assistant in here later needs no change to the gate or the endpoint.
      el.style.display = 'block';
      el.scrollIntoView({ behavior:'smooth' });
    }

    // Qualified: only now does any calendar markup exist on this page.
    function showStep2(lead){
      document.getElementById('step1').style.display = 'none';
      var el = document.getElementById('step2');
      el.innerHTML = ${jsonForScript(`<h2>Pick a time</h2><p class="muted" id="bookingas"></p><div id="slots" class="card"><p class="muted">Loading available times…</p></div>`)}
        + (lead ? ${jsonForScript(bookingFormHtml(true))} : ${jsonForScript(bookingFormHtml(false))});
      var greet = document.getElementById('bookingas');
      if (lead) {
        // textContent — the lead's own name and email, never markup.
        greet.textContent = 'Booking as ' + (lead.name ? lead.name + ' · ' : '') + lead.email;
      } else {
        greet.style.display = 'none';
      }
      if (HEADSHOT) {
        var img = document.createElement('img'); img.className = 'headshot'; img.src = HEADSHOT; img.alt = '';
        el.insertBefore(img, el.firstChild);
      }
      el.style.display = 'block';
      el.scrollIntoView({ behavior:'smooth' });
      // The application answers ride along so the server re-runs the gate on the
      // same submission rather than trusting that this page ran it.
      initBooking({ lead: lead, answers: answers });
    }

    document.getElementById('qnext').addEventListener('click', next);
    document.getElementById('qback').addEventListener('click', function(){ if (idx > 0) { answers[QUESTIONS[idx].id] = currentValue(); idx--; renderQ(); } });
    renderQ();
    api({ action:'start' }, function(){}, function(){});`

  return shell(b.brand, bp.headline || 'Apply for your call', body, script, b.head, siteFooter(b))
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

// Lead-facing copy comes from the generator, which writes CTA links as tokens
// ([BOOK_A_CALL_LINK] etc). The email sender substitutes them; the training page
// did NOT, so a lead saw a literal "[BOOK_A_CALL_LINK]" in the key takeaways.
// This substitutes them the same way, as real clickable links.
//
// The anchor TEXT is the destination URL, not a phrase. An earlier version used
// the label "book a call", which doubled up against copy that already names the
// action: "Book a call with Jamaul at book a call to see whether…". Showing the
// address reads naturally after the prepositions the generator actually writes
// ("at …", "here: …") and never repeats the surrounding words.
//
// The href stays RELATIVE (?page=book&subdomain=…), matching the page's own CTA —
// an absolute href would break the preview render, which is served off a path with
// ?subdomain= rather than the live subdomain. Only the visible label is absolute.
//
// Order matters: escape FIRST, then swap tokens for anchors. The tokens contain no
// HTML-special characters so they survive escaping intact, and both href and label
// are ours (never lead input), so injecting the anchor after escaping stays XSS-safe.
function escapeWithLinks(text: unknown, funnel: Record<string, any>): string {
  const sub = typeof funnel.subdomain === 'string' ? funnel.subdomain : ''
  const host = sub ? `${sub}.${FUNNEL_PUBLIC_DOMAIN}` : ''
  // In sell mode the "book a call" tokens the generator wrote point at the offer
  // instead — there is no calendar to send anyone to.
  const bookHref = sellMode(funnel) ? offerHref(funnel) : `?page=book${subQuery(funnel)}`
  const trainingHref = `?page=training${subQuery(funnel)}`
  // Fall back to a short phrase only when there is no subdomain to show (preview).
  const label = (path: string, fallback: string) => (host ? escapeHtml(`${host}/${path}`) : fallback)
  const anchor = (href: string, text: string) => `<a href="${href}">${text}</a>`
  const bookLink = anchor(bookHref, label('?page=book', 'book a call'))
  const trainingLink = anchor(trainingHref, label('?page=training', 'the training'))
  return escapeHtml(text)
    .replace(/\[BOOK_A_CALL_LINK\]/g, bookLink)
    .replace(/\[OFFER_LINK\]/g, bookLink)
    .replace(/\[TRAINING_LINK\]/g, trainingLink)
    .replace(/\[GUIDE_LINK\]/g, trainingLink)
    .replace(/\[FUNNEL_LINK\]/g, anchor(`?${subQuery(funnel).replace(/^&amp;/, '')}`, host ? escapeHtml(host) : 'the page'))
}

// Embed a value as a JS literal inside an inline <script>.
//
// Question labels and dropdown options are the coach's free text, so plain
// JSON.stringify is not enough: a label containing "</script>" would close the
// tag and everything after it would parse as markup. '<' is never structural in
// JSON, so escaping every one of them to < is safe and leaves the decoded
// string identical. U+2028/2029 are valid in JSON strings but are line
// terminators in older JS parsers.
function jsonForScript(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function escapeAttr(s: unknown): string {
  return escapeHtml(s)
}
