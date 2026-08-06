import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { isSafePathSegment, signImageUpload } from '../../lib/uploadUrl'

// POST /api/slides/upload-url?card_id=... — the signed-URL counterpart to
// api/slides/upload-image.ts, for the same reason as api/forum/upload-url.ts:
// a direct-to-function upload cannot exceed the ~4.5MB platform body cap.
// See lib/rawBody.ts.
//
// Request:  { content_type: 'image/png', size: 1234567 }   — size is REQUIRED
// Response: { uploadUrl, token, path, publicUrl, maxBytes }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const rawCardId = req.query && req.query.card_id
  const cardId = Array.isArray(rawCardId) ? rawCardId[0] : rawCardId
  // card_id lands in the storage path, and unlike the user id it comes from the
  // request. Constrain it to an id before interpolating so nothing can climb out
  // of the member's prefix.
  if (!isSafePathSegment(cardId)) {
    return res.status(400).json({ error: 'card_id required' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const contentType = typeof body.content_type === 'string' ? body.content_type : ''
  // Required. A missing size would push the refusal onto storage, whose
  // oversize answer is an HTTP 400 with "statusCode":"413" in the body — a
  // refusal no frontend can detect by status. See lib/uploadUrl.ts.
  const size = typeof body.size === 'number' ? body.size : null

  try {
    const result = await signImageUpload({
      bucket: 'slide-images',
      prefix: `${userId}/${cardId}`,
      contentType,
      declaredBytes: size,
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })

    return res.status(200).json(result.upload)
  } catch (err) {
    console.error('[slides/upload-url]', err)
    return res.status(500).json({ error: 'Failed to prepare upload' })
  }
}
