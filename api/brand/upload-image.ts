import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { DIRECT_UPLOAD_MAX_BYTES, readBoundedBody, respondTooLarge, tooLargeMessage } from '../../lib/rawBody'

// POST /api/brand/upload-image?field=logo|headshot — raw image bytes,
// Content-Type set to the image's real mime type.
//
// WHY THIS EXISTS RATHER THAN REUSING upload-avatar. The Brand Identity fields
// are a coach's PUBLIC brand — they appear on funnel pages, their booking page,
// and every coach-branded email. users.avatar_url is the account's own picture
// and is private. Those are different things owned by the same person, which is
// exactly the confusion that had funnel pages publishing the account photo.
//
// So this endpoint writes funnel_business_settings.logo_url / .headshot_url and
// NEVER users.avatar_url. api/auth/upload-avatar.ts writes the other one and
// never these. Two endpoints, because they are two decisions.
//
// Without it a coach has to host an image somewhere before they can paste a URL,
// which is where the drop-off is: "no headshot yet" plus an https:// box asks
// somebody to go and solve a problem before they can finish this one.
export const config = {
  api: { bodyParser: false },
}

// Capped below Vercel's ~4.5MB edge limit like every other raw-body endpoint —
// see lib/rawBody.ts. Above that the request never reaches this function.
const MAX_BYTES = DIRECT_UPLOAD_MAX_BYTES

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

// The only two fields this endpoint may write, as an allowlist rather than a
// pass-through. A query param that reaches a column name is a column name the
// caller chooses.
const FIELDS: Record<string, 'logo_url' | 'headshot_url'> = {
  logo: 'logo_url',
  headshot: 'headshot_url',
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const rawField = req.query && req.query.field
  const fieldKey = Array.isArray(rawField) ? rawField[0] : rawField
  const column = typeof fieldKey === 'string' ? FIELDS[fieldKey] : undefined
  if (!column) {
    return res.status(400).json({ error: "field must be 'logo' or 'headshot'" })
  }

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = ALLOWED_TYPES[contentType]
  if (!ext) {
    return res.status(415).json({ error: 'Unsupported image type — jpg, png, and webp only' })
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
    if (buffer.length === 0) return res.status(400).json({ error: 'No image data received' })

    // A FIXED path per coach per field, upsert:true — a re-upload replaces the
    // previous one rather than leaving it orphaned in the bucket, and the
    // cache-busted URL is what makes the change visible. No extension in the
    // path, so switching png -> jpg still overwrites the same object;
    // contentType is passed explicitly so it is still served correctly.
    const path = `brand/${userId}/${fieldKey}`
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, buffer, { contentType, upsert: true })
    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(path)
    const url = `${publicUrlData.publicUrl}?v=${Date.now()}`

    // Upsert, because a coach who has never saved Brand Identity has no row yet
    // and uploading a logo should not require saving the form first.
    const { error: saveError } = await supabase
      .from('funnel_business_settings')
      .upsert({ user_id: userId, [column]: url, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (saveError) throw saveError

    return res.status(200).json({ ok: true, field: fieldKey, url })
  } catch (err) {
    console.error('[brand/upload-image]', err)
    return res.status(500).json({ error: 'Failed to upload image' })
  }
}
