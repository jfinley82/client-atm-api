import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// POST /api/slides/upload-image?card_id=... — body is the raw image bytes,
// Content-Type set to the image's real mime type. Vercel's default JSON body
// parser can't handle that, so bodyParser is disabled and the body is read as a
// raw byte stream — the same approach api/guide/publish.ts / api/auth/upload-avatar.ts
// use. Hosts an image the slide editor drops onto a slide, on the public
// `slide-images` bucket. Unlike the guide PDF, each upload is a NEW object
// (upsert:false, unique timestamped path) so slides can carry many images.
export const config = {
  api: { bodyParser: false },
}

const MAX_BYTES = 10 * 1024 * 1024 // 10MB

// Allowed image types → file extension.
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

  const rawCardId = req.query && req.query.card_id
  const cardId = Array.isArray(rawCardId) ? rawCardId[0] : rawCardId
  if (!cardId || typeof cardId !== 'string') {
    return res.status(400).json({ error: 'card_id required' })
  }

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

    // A NEW object per upload — timestamp + short random keep paths unique so a
    // slide can carry many images and re-drops never clobber an earlier one.
    const rand = Math.random().toString(36).slice(2, 8)
    const path = `${userId}/${cardId}/${Date.now()}-${rand}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('slide-images')
      .upload(path, buffer, { contentType, upsert: false })
    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage.from('slide-images').getPublicUrl(path)
    const url = `${publicUrlData.publicUrl}?v=${Date.now()}`

    return res.status(200).json({ ok: true, url })
  } catch (err) {
    console.error('[slides/upload-image]', err)
    return res.status(500).json({ error: 'Failed to upload image' })
  }
}
