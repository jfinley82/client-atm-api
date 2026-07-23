import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { requireAdmin } from '../../../../../lib/auth'
import { setCors } from '../../../../../lib/cors'

// POST /api/hub/admin/listings/[id]/cover — raw image bytes (Content-Type =
// image/jpeg|png|webp). Mirrors api/auth/upload-avatar.ts: bodyParser off, 5MB
// bound, public hub-covers bucket, fixed path (listing id), cache-busted URL.
export const config = {
  api: { bodyParser: false },
}

const MAX_BYTES = 5 * 1024 * 1024 // 5MB
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

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

  const userId = await requireAdmin(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_TYPES.has(contentType)) {
    return res.status(400).json({ error: 'Unsupported image type — jpg, png, and webp only' })
  }

  try {
    // Only accept a cover for a real listing.
    const { data: listing } = await supabase.from('hub_listings').select('id').eq('id', id).maybeSingle()
    if (!listing) return res.status(404).json({ error: 'Listing not found' })

    let buffer: Buffer
    try {
      buffer = await readBoundedBody(req)
    } catch (readErr) {
      if (readErr instanceof Error && readErr.message === 'file_too_large') {
        return res.status(400).json({ error: 'Image must be 5MB or smaller' })
      }
      throw readErr
    }
    if (buffer.length === 0) return res.status(400).json({ error: 'No image data received' })

    // Fixed path (no extension) so a re-upload overwrites the same object.
    const path = `hub-covers/${id}`
    const { error: uploadError } = await supabase.storage.from('hub-covers').upload(path, buffer, { contentType, upsert: true })
    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage.from('hub-covers').getPublicUrl(path)
    const cover_url = `${publicUrlData.publicUrl}?v=${Date.now()}`

    const { error: updateError } = await supabase.from('hub_listings').update({ cover_url, updated_at: new Date().toISOString() }).eq('id', id)
    if (updateError) throw updateError

    return res.status(200).json({ ok: true, cover_url })
  } catch (err) {
    console.error('[hub/admin/listings/[id]/cover]', err)
    return res.status(500).json({ error: 'Failed to upload cover' })
  }
}
