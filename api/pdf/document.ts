import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser, getSessionFromRequest } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { buildCoverPage } from '../../lib/pdf/cover'
import { DocType } from '../../lib/pdf/assets'
import { paginate, buildDocument, Block } from '../../lib/pdf/shell'
import { buildFrameworkBlocks } from '../../lib/pdf/bodyFramework'
import { buildGuideBlocks } from '../../lib/pdf/bodyGuide'
import { buildScriptBlocks } from '../../lib/pdf/bodyScript'

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

const DOC_LABEL: Record<DocType, string> = { framework: 'Framework', guide: 'Guide', script: 'Script' }

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})

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
    const frameworkName = typeof obj(obj(results.framework).framework).frameworkName === 'string'
      ? (obj(obj(results.framework).framework).frameworkName as string).trim()
      : ''

    // Build the interior body for the requested doc.
    let docTitle = frameworkName || 'Your framework'
    let blocks: Block[]
    if (doc === 'framework') {
      const built = buildFrameworkBlocks(results)
      docTitle = built.docTitle
      blocks = built.blocks
    } else {
      const gen = await supabase
        .from('mtm_generations')
        .select('workbook, sales_script')
        .eq('user_id', userId)
        .eq('card_id', cardId)
        .maybeSingle()
      if (gen.error) throw gen.error
      if (!gen.data) return res.status(404).json({ error: 'No generation for this card' })
      const built = doc === 'guide'
        ? buildGuideBlocks(gen.data.workbook, frameworkName)
        : buildScriptBlocks(gen.data.sales_script, frameworkName)
      docTitle = built.docTitle
      blocks = built.blocks
    }

    // Assemble the full print-ready HTML: cover page + paginated interior.
    const cover = buildCoverPage(doc, frameworkName || docTitle, coachName)
    const { html: interior } = paginate(blocks, docTitle.toUpperCase(), 2)
    const html = buildDocument(cover, interior)

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
