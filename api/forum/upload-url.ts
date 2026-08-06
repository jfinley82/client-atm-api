import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { signImageUpload } from '../../lib/uploadUrl'

// POST /api/forum/upload-url — mint a signed URL the browser PUTs the image to
// directly, bypassing the ~4.5MB platform body cap that makes
// api/forum/upload-image.ts unable to accept anything larger. See lib/rawBody.ts
// for the ceiling and lib/uploadUrl.ts for what still enforces size and type
// once this function is no longer in the transfer path.
//
// Request:  { content_type: 'image/png', size?: 1234567 }
// Response: { uploadUrl, token, path, publicUrl, maxBytes }
//
// The frontend then does:
//   await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': type }, body: file })
// and on success stores publicUrl.
//
// api/forum/upload-image.ts stays live and unchanged in behaviour until the
// frontend adopts this; it is simply capped at what the platform will actually
// carry.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const contentType = typeof body.content_type === 'string' ? body.content_type : ''
  const size = typeof body.size === 'number' ? body.size : null

  try {
    // A forum image belongs to the member, not to a blueprint, so the prefix is
    // the user id alone — and it comes from the session, never the body.
    const result = await signImageUpload({
      bucket: 'forum-media',
      prefix: userId,
      contentType,
      declaredBytes: size,
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })

    return res.status(200).json(result.upload)
  } catch (err) {
    console.error('[forum/upload-url]', err)
    return res.status(500).json({ error: 'Failed to prepare upload' })
  }
}
