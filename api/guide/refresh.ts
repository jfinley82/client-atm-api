import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser, getSessionFromRequest } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { API_URL } from '../../lib/appUrls'
import { buildGuideHtml } from '../../lib/pdf/guideRender'
import { storeGuidePdf } from '../../lib/guideStorage'

// POST /api/guide/refresh — body { card_id }. Renders the coach-branded Guide
// PDF SERVER-SIDE (lib/pdf/guideRender -> /api/pdf/render), stores it on the
// public `guides` bucket, and refreshes mtm_generations.guide_url with a new
// cache-busted stamp. This is the "Approve Guide" action: it makes the stored
// link (used by the funnel confirmation email's [GUIDE_LINK]) the current branded
// PDF. Returns { ok, guide_url }.
//
// Replaces the old client-upload publish flow for approval: the coach can no
// longer render the branded template client-side, so the server owns the render.
// A render + chromium call can stack, so this function gets 60s.
export const config = { maxDuration: 60 }


export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return
  const token = getSessionFromRequest(req) || ''

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const cardId = typeof body.card_id === 'string' ? body.card_id.trim() : ''
  if (!cardId) return res.status(400).json({ error: 'card_id required' })

  try {
    const built = await buildGuideHtml({ userId, token, cardId, apiUrl: API_URL })
    if (!built) return res.status(404).json({ error: 'No generation for this card' })

    const renderRes = await fetch(`${API_URL}/api/pdf/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ html: built.html, filename: built.filename, format: 'Letter' }),
    })
    if (!renderRes.ok) {
      const detail = await renderRes.text().catch(() => '')
      console.error('[guide/refresh] render failed', renderRes.status, detail.slice(0, 200))
      return res.status(502).json({ error: 'Failed to render the guide PDF' })
    }
    const pdf = Buffer.from(await renderRes.arrayBuffer())

    const guide_url = await storeGuidePdf(userId, cardId, pdf)
    return res.status(200).json({ ok: true, guide_url })
  } catch (err) {
    console.error('[guide/refresh]', err)
    return res.status(500).json({ error: 'Failed to refresh the guide' })
  }
}
