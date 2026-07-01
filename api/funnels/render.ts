import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

// PUBLIC — no auth. Resolves a funnel from the request's subdomain and serves a
// minimal placeholder page. Real page rendering comes in later phases; the point
// of building this now is to prove the subdomain -> funnel lookup works end to end.
//
// Subdomain resolution: the leftmost label of the Host header (e.g. the "coachx"
// in coachx.funnels.example.com). A ?subdomain= query override is supported so
// the lookup is testable before wildcard DNS is wired up.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const rawQuery = req.query?.subdomain
  const querySub = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery
  const host = (req.headers.host || '').split(':')[0]
  const hostSub = host.split('.')[0]
  const subdomain = (querySub && String(querySub)) || hostSub

  if (!subdomain) return send404(res)

  const { data: funnel, error } = await supabase
    .from('funnels')
    .select('subdomain, status, template_id, brand_primary_color, brand_secondary_color, theme_mode')
    .eq('subdomain', subdomain)
    .maybeSingle()

  if (error) {
    console.error('[funnels/render]', error)
    return res.status(500).json({ error: 'Failed to render funnel' })
  }

  if (!funnel || funnel.status !== 'live') return send404(res)

  const primary = funnel.brand_primary_color || '#020c31'
  const secondary = funnel.brand_secondary_color || '#6dd80e'
  const isDark = funnel.theme_mode !== 'light'
  const text = isDark ? '#ffffff' : primary
  const bg = isDark ? primary : '#ffffff'

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="${isDark ? 'dark' : 'light'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Coming soon</title>
  <style>
    html, body { margin: 0; height: 100%; }
    body {
      display: flex; align-items: center; justify-content: center;
      background: ${bg}; color: ${text};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      text-align: center; padding: 2rem;
    }
    .badge { width: 56px; height: 56px; border-radius: 9999px; background: ${secondary}; margin: 0 auto 1.25rem; }
    h1 { font-size: 1.75rem; margin: 0 0 .5rem; }
    p { opacity: .7; margin: 0; }
  </style>
</head>
<body>
  <main>
    <div class="badge"></div>
    <h1>Funnel coming soon</h1>
    <p>${escapeHtml(subdomain)}</p>
  </main>
</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.status(200).send(html)
}

function send404(res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.status(404).send('<!DOCTYPE html><html><body><h1>404</h1><p>Funnel not found</p></body></html>')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}
