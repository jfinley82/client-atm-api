import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// POST /api/guide/publish?card_id=... — body is the raw PDF bytes, Content-Type
// application/pdf. Vercel's default JSON body parser can't handle that, so
// bodyParser is disabled and the body is read as a raw byte stream instead — the
// same approach api/auth/upload-avatar.ts and api/stripe/webhook.ts use.
// Hosts the generated Guide PDF for a (user_id, card_id) generation on the public
// `guides` bucket and records its URL on mtm_generations.guide_url.
export const config = {
  api: { bodyParser: false },
}

const MAX_BYTES = 10 * 1024 * 1024 // 10MB

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
  if (contentType !== 'application/pdf') {
    return res.status(400).json({ error: 'Unsupported file type — application/pdf only' })
  }

  try {
    let buffer: Buffer
    try {
      buffer = await readBoundedBody(req)
    } catch (readErr) {
      if (readErr instanceof Error && readErr.message === 'file_too_large') {
        return res.status(400).json({ error: 'PDF must be 10MB or smaller' })
      }
      throw readErr
    }

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'No PDF data received' })
    }

    // One object per (coach, card); a re-publish overwrites the SAME object
    // rather than orphaning the previous PDF. contentType is passed explicitly
    // so the object is served as a PDF regardless of path.
    const path = `${userId}/${cardId}.pdf`
    const { error: uploadError } = await supabase.storage
      .from('guides')
      .upload(path, buffer, { contentType: 'application/pdf', upsert: true })
    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage.from('guides').getPublicUrl(path)
    // Cache-bust: the object path never changes across re-publishes, so without
    // this a browser/CDN could keep serving the previous PDF after a re-publish.
    const guide_url = `${publicUrlData.publicUrl}?v=${Date.now()}`

    const { error: updateError } = await supabase
      .from('mtm_generations')
      .update({ guide_url, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('card_id', cardId)
    if (updateError) throw updateError

    return res.status(200).json({ ok: true, guide_url })
  } catch (err) {
    console.error('[guide/publish]', err)
    return res.status(500).json({ error: 'Failed to publish guide' })
  }
}
