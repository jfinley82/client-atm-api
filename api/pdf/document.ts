import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser, getSessionFromRequest } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { buildCoverPage } from '../../lib/pdf/cover'
import { DocType } from '../../lib/pdf/assets'
import { paginate, buildDocument, assembleSteps } from '../../lib/pdf/shell'
import { buildFrameworkDoc } from '../../lib/pdf/bodyFramework'
import { buildScriptBlocks } from '../../lib/pdf/bodyScript'
import { buildGuideDocument, GuideBrand, NEUTRAL_ACCENT, accentShades } from '../../lib/pdf/guideDoc'
import { bookingQrDataUri } from '../../lib/pdf/qr'
import { loadBusinessSettings } from '../../lib/businessSettings'
import { isValidBrandColor } from '../../lib/funnels'

// POST /api/pdf/document — assemble one of the branded document PDFs (framework,
// guide, script) and return the bytes. Gathers the coach's data, builds the
// print-ready HTML (cover page + interior shell) with the Node font-fit, then
// POSTs { html, filename } to the unchanged /api/pdf/render engine and streams
// the PDF back. Slides are not a PDF and are not handled here.
//
// results (60s ceiling incl. lazy synopsis regen) + a chromium render can stack,
// so this function gets 60s. It needs opentype + the cover/font assets bundled
// (see vercel.json includeFiles); it does NOT launch chromium itself.
export const config = { maxDuration: 60 }

// The API's own public base URL, for the internal results + render calls. Same
// pattern lib/email.ts / lib/funnelNurture.ts use.
const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'
// The public funnel domain the coach's booking page serves on — same resolution
// the nurture emails use. NEVER an MTM domain (the guide carries zero MTM branding).
const FUNNEL_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'

const DOC_LABEL: Record<DocType, string> = { framework: 'Framework', guide: 'Guide', script: 'Script' }

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return
  const token = getSessionFromRequest(req) || ''

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Any
  const doc = body.doc
  if (doc !== 'framework' && doc !== 'guide' && doc !== 'script') {
    return res.status(400).json({ error: "doc must be 'framework', 'guide', or 'script'" })
  }
  const cardId = typeof body.card_id === 'string' ? body.card_id : ''
  if ((doc === 'guide' || doc === 'script') && !cardId) {
    return res.status(400).json({ error: 'card_id required for guide and script' })
  }

  try {
    // The coach's display name for the "prepared for" slot.
    const userRow = await supabase.from('users').select('name').eq('id', userId).maybeSingle()
    const coachName = typeof userRow.data?.name === 'string' ? userRow.data.name.trim() : ''

    // Results carry the framework name (cover title + running header for all docs)
    // and, for the framework doc, the full Steps 1-3 payload.
    const resultsRes = await fetch(`${API_URL}/api/micro-blueprints/results`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!resultsRes.ok) throw new Error(`results ${resultsRes.status}`)
    const results = (await resultsRes.json()) as Any
    const fw = obj(obj(results.framework).framework)
    const rawName = fw.frameworkName ?? fw.framework_name
    const frameworkName = typeof rawName === 'string' ? rawName.trim() : ''

    // Build the interior for the requested doc. The framework doc interleaves
    // chalkboard step dividers with paginated content (assembleSteps); guide +
    // script are a single paginated flow. Cover page is always page 1, so the
    // interior starts numbering at page 2.
    let docTitle = frameworkName || 'Your framework'
    let html: string

    if (doc === 'guide') {
      // The lead-magnet Guide is a self-contained COACH-branded document — its own
      // cover + shell, themed from the coach's brand tokens, with ZERO MTM branding.
      // It does NOT use buildCoverPage/buildDocument (those carry the MTM chalkboard).
      const gen = await supabase
        .from('mtm_generations')
        .select('workbook, delivery, chosen_angle')
        .eq('user_id', userId)
        .eq('card_id', cardId)
        .maybeSingle()
      if (gen.error) throw gen.error
      if (!gen.data) return res.status(404).json({ error: 'No generation for this card' })

      // Brand tokens — resolved once, non-MTM fallbacks only.
      const settings = await loadBusinessSettings(userId)
      const deliveryObj = obj(gen.data.delivery)
      const presenterName = str(deliveryObj.presenter_name) || coachName || settings.business_name || 'Your coach'
      const businessName = (settings.business_name && settings.business_name.trim()) || presenterName
      const accent = isValidBrandColor(settings.brand_primary_color) ? settings.brand_primary_color : NEUTRAL_ACCENT

      // Booking URL from the coach's funnel subdomain (same resolution the emails
      // use). Fallback: the funnel base — never an MTM link, never a minted token.
      let bookingUrl = `https://${FUNNEL_DOMAIN}`
      const funnelRes = await supabase
        .from('funnels')
        .select('subdomain')
        .eq('user_id', userId)
        .not('subdomain', 'is', null)
        .limit(1)
      const subdomain = funnelRes.data?.[0]?.subdomain
      if (typeof subdomain === 'string' && subdomain.trim()) bookingUrl = `https://${subdomain.trim()}.${FUNNEL_DOMAIN}/?page=book`
      let bookingDisplay = FUNNEL_DOMAIN
      try {
        bookingDisplay = new URL(bookingUrl).host
      } catch {
        /* keep the domain */
      }

      const qrDataUri = await bookingQrDataUri(bookingUrl, accentShades(accent).ink)
      const brand: GuideBrand = { businessName, presenterName, accent, bookingUrl, bookingDisplay }

      const workbook = obj(gen.data.workbook)
      const coverTitle = str(workbook.title) || str(gen.data.chosen_angle) || frameworkName
      const analysis = obj(obj(results.transformation).analysis)
      docTitle = coverTitle || frameworkName || 'Your guide'
      html = buildGuideDocument({ brand, workbook: gen.data.workbook, analysis, delivery: gen.data.delivery, frameworkName, coverTitle, qrDataUri })
    } else {
      let interior: string
      if (doc === 'framework') {
        const built = buildFrameworkDoc(results)
        docTitle = built.docTitle
        interior = assembleSteps(built.sections, docTitle, 2).html
      } else {
        const gen = await supabase
          .from('mtm_generations')
          .select('sales_script')
          .eq('user_id', userId)
          .eq('card_id', cardId)
          .maybeSingle()
        if (gen.error) throw gen.error
        if (!gen.data) return res.status(404).json({ error: 'No generation for this card' })
        const built = buildScriptBlocks(gen.data.sales_script, frameworkName)
        docTitle = built.docTitle
        interior = paginate(built.blocks, docTitle, 2).html
      }
      // Framework + script keep the shared cover + interior shell.
      const coverTitle = frameworkName || docTitle
      const cover = buildCoverPage(doc, coverTitle, coachName)
      html = buildDocument(cover, interior)
    }

    const filename = `${(frameworkName || docTitle).slice(0, 80)} - ${DOC_LABEL[doc]}`

    // Render via the unchanged engine.
    const renderRes = await fetch(`${API_URL}/api/pdf/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ html, filename, format: 'Letter' }),
    })
    if (!renderRes.ok) {
      const detail = await renderRes.text().catch(() => '')
      console.error('[pdf/document] render failed', renderRes.status, detail.slice(0, 200))
      return res.status(502).json({ error: 'PDF render failed' })
    }
    const pdf = Buffer.from(await renderRes.arrayBuffer())

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`)
    res.setHeader('Content-Length', String(pdf.length))
    return res.status(200).send(pdf)
  } catch (err) {
    console.error('[pdf/document] build failed', err)
    return res.status(500).json({ error: 'Failed to build document' })
  }
}
