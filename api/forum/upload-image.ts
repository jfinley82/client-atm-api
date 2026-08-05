import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// POST /api/forum/upload-image — body is the raw image bytes, Content-Type set
// to the image's real mime type. Vercel's default JSON body parser can't handle
// that, so bodyParser is disabled and the body is read as a raw byte stream —
// the same approach api/slides/upload-image.ts uses.
//
// Hosts an image a member attaches to a community post or comment, on the
// public `forum-media` bucket. Unlike the slide uploader this is NOT scoped to
// a card: a forum image belongs to the member, not to a blueprint, so the path
// is keyed by user id alone.
export const config = {
  api: { bodyParser: false },
}

const MAX_BYTES = 10 * 1024 * 1024 // 10MB

// Allowed image types → file extension. An allowlist, so an upload can only
// ever become one of these regardless of what the client claims.
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// Reads the request body into a Buffer, aborting once MAX_BYTES is exceeded so an
// oversized upload can't be accumulated into memory unbounded.
function readBoundedBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BYTES) {
        req.destroy()
        reject(new Error('file_too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = EXT_BY_TYPE[contentType]
  if (!ext) {
    return res.status(415).json({ error: 'Unsupported image type — png, jpeg, webp, and gif only' })
  }

  try {
    let buffer: Buffer
    try {
      buffer = await readBoundedBody(req)
    } catch (readErr) {
      if (readErr instanceof Error && readErr.message === 'file_too_large') {
        return res.status(413).json({ error: 'Image must be 10MB or smaller' })
      }
      throw readErr
    }

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'No image data received' })
    }

    // A NEW object per upload — timestamp + short random keep paths unique, so a
    // post can carry many images and a re-upload never clobbers an earlier one.
    const rand = Math.random().toString(36).slice(2, 8)
    const path = `${userId}/${Date.now()}-${rand}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('forum-media')
      .upload(path, buffer, { contentType, upsert: false })
    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage.from('forum-media').getPublicUrl(path)
    const url = `${publicUrlData.publicUrl}?v=${Date.now()}`

    return res.status(200).json({ ok: true, url })
  } catch (err) {
    console.error('[forum/upload-image]', err)
    return res.status(500).json({ error: 'Failed to upload image' })
  }
}
