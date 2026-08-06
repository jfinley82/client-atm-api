import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { storeGuidePdf } from '../../lib/guideStorage'
import { DIRECT_UPLOAD_MAX_BYTES, DIRECT_UPLOAD_MAX_LABEL, readBoundedBody } from '../../lib/rawBody'

// POST /api/guide/publish?card_id=... — body is the raw PDF bytes, Content-Type
// application/pdf. Vercel's default JSON body parser can't handle that, so
// bodyParser is disabled and the body is read as a raw byte stream instead — the
// same approach api/auth/upload-avatar.ts and api/stripe/webhook.ts use.
// Hosts the generated Guide PDF for a (user_id, card_id) generation on the public
// `guides` bucket and records its URL on mtm_generations.guide_url.
export const config = {
  api: { bodyParser: false },
}

// 4MB, not the 10MB this once claimed — see lib/rawBody.ts. Vercel's ~4.5MB
// edge cap made the old limit unreachable, so a large Guide PDF failed as an
// unexplained network error rather than the 400 below. A PDF that genuinely
// exceeds this needs the signed-URL treatment lib/uploadUrl.ts gives images.
const MAX_BYTES = DIRECT_UPLOAD_MAX_BYTES

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const rawCardId = req.query && req.query.card_id
  const cardId = Array.isArray(rawCardId) ? rawCardId[0] : rawCardId
  if (!cardId || typeof cardId !== 'string') {
    return res.status(400).json({ error: 'card_id required' })
  }

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/pdf') {
    return res.status(400).json({ error: 'Unsupported file type — application/pdf only' })
  }

  try {
    let buffer: Buffer
    try {
      buffer = await readBoundedBody(req, MAX_BYTES)
    } catch (readErr) {
      if (readErr instanceof Error && readErr.message === 'file_too_large') {
        return res.status(400).json({ error: `PDF must be ${DIRECT_UPLOAD_MAX_LABEL} or smaller` })
      }
      throw readErr
    }

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'No PDF data received' })
    }

    // Store the uploaded PDF + stamp mtm_generations.guide_url (shared with the
    // server-side render path, POST /api/guide/refresh).
    const guide_url = await storeGuidePdf(userId, cardId, buffer)
    return res.status(200).json({ ok: true, guide_url })
  } catch (err) {
    console.error('[guide/publish]', err)
    return res.status(500).json({ error: 'Failed to publish guide' })
  }
}
