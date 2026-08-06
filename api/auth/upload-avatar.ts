import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { DIRECT_UPLOAD_MAX_BYTES, DIRECT_UPLOAD_MAX_LABEL, readBoundedBody, respondTooLarge, tooLargeMessage } from '../../lib/rawBody'

// POST /api/auth/upload-avatar — body is the raw image bytes, Content-Type
// set to the image's real mime type (image/jpeg, image/png, or image/webp).
// Vercel's default JSON body parser can't handle that, so bodyParser is
// disabled and the body is read as a raw byte stream instead — the same
// approach api/stripe/webhook.ts already uses for its raw body.
export const config = {
  api: { bodyParser: false },
}

// 4MB, not the 5MB this once claimed: Vercel refuses a serverless request
// body over roughly 4.5MB at the edge, so the old cap was unreachable and an
// oversized avatar died as an unexplained network error. See lib/rawBody.ts.
const MAX_BYTES = DIRECT_UPLOAD_MAX_BYTES
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_TYPES.has(contentType)) {
    return res.status(400).json({ error: 'Unsupported image type — jpg, png, and webp only' })
  }

  try {
    let buffer: Buffer
    try {
      buffer = await readBoundedBody(req, MAX_BYTES)
    } catch (readErr) {
      if (readErr instanceof Error && readErr.message === 'file_too_large') {
        return respondTooLarge(res, tooLargeMessage('Image'))
      }
      throw readErr
    }

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'No image data received' })
    }

    // Fixed path, no extension — a re-upload in a different format (e.g. png
    // after jpg) still overwrites the SAME object rather than leaving the old
    // one orphaned in storage. contentType is passed explicitly so the object
    // is still served with the correct Content-Type regardless of path.
    const path = `avatars/${userId}`
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, buffer, { contentType, upsert: true })
    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(path)
    // Cache-bust: the object path never changes across re-uploads, so
    // without this a browser/CDN could keep serving the previous photo after
    // a successful re-upload.
    const avatar_url = `${publicUrlData.publicUrl}?v=${Date.now()}`

    const { error: updateError } = await supabase.from('users').update({ avatar_url }).eq('id', userId)
    if (updateError) throw updateError

    return res.status(200).json({ ok: true, avatar_url })
  } catch (err) {
    console.error('[auth/upload-avatar]', err)
    return res.status(500).json({ error: 'Failed to upload avatar' })
  }
}
