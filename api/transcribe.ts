import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../lib/auth'
import { setCors } from '../lib/cors'
import { logAudioCost } from '../lib/apiCostLog'

// POST /api/transcribe — a pure "audio in, text out" service shared by every
// voice-input surface (Voice & Style Guide, the Step 1-3 tool chats, MTM
// Coach chat, ...). Deliberately tool-agnostic: it has no idea which
// conversation the audio came from, never touches saved_outputs or any
// tool's own state, and returns only { text } — the caller submits that text
// through whatever endpoint it would already submit a typed answer to.
//
// Auth-gated only (requireActiveUser), NOT tier-gated. Every Step 1-3 tool
// and the Voice Guide already require a paid tier before their chat is even
// reachable, so tier enforcement there is unchanged. But MTM Coach chat
// (api/assistant/chat.ts) is available to ALL active members regardless of
// tier — tier-gating this endpoint would silently break voice input there,
// which contradicts the point of making this generic. Groq transcription is
// cheap enough that "real, active, non-suspended account" is the right bar.
//
// Body is the raw audio bytes (MediaRecorder output), Content-Type set to the
// real mime type. Same raw-body approach as api/auth/upload-avatar.ts and
// api/stripe/webhook.ts — Vercel's default JSON parser can't handle this.
export const config = {
  api: { bodyParser: false },
}

// Comfortably below Groq's own 25MB hard limit. Not a real constraint on
// legitimate use — even low-bitrate opus (~24kbps) is roughly 1.5MB/minute,
// so 20MB covers well over 3 hours of a single spoken answer. This is a
// safety cap against a runaway or corrupt upload, not a UX limit.
const MAX_BYTES = 20 * 1024 * 1024

// Every content-type MediaRecorder actually emits across browsers (Chrome/
// Edge/Firefox default to webm/opus, Firefox can also emit ogg, Safari emits
// mp4/aac), plus plain formats for direct testing — mapped to the file
// extension Groq's multipart upload needs to infer the audio format from.
const CONTENT_TYPE_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

const GROQ_MODEL = 'whisper-large-v3'

// Reads the request body into a Buffer, aborting once MAX_BYTES is exceeded
// so an oversized upload can't be accumulated into memory unbounded — same
// idiom as api/auth/upload-avatar.ts's readBoundedBody.
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

  if (!process.env.GROQ_API_KEY) {
    console.error('[transcribe] GROQ_API_KEY is not set')
    return res.status(500).json({ error: 'transcription_unavailable' })
  }

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = CONTENT_TYPE_EXT[contentType]
  if (!ext) {
    return res.status(400).json({ error: 'unsupported_audio_type' })
  }

  let buffer: Buffer
  try {
    buffer = await readBoundedBody(req)
  } catch (readErr) {
    if (readErr instanceof Error && readErr.message === 'file_too_large') {
      return res.status(400).json({ error: 'audio_too_large' })
    }
    console.error('[transcribe] body read failed', readErr)
    return res.status(500).json({ error: 'transcription_failed' })
  }

  if (buffer.length === 0) {
    return res.status(400).json({ error: 'no_audio_received' })
  }

  try {
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(buffer)], { type: contentType }), `audio.${ext}`)
    form.append('model', GROQ_MODEL)
    form.append('response_format', 'verbose_json')

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    })

    if (!groqRes.ok) {
      const errBody = await groqRes.text().catch(() => '')
      console.error('[transcribe] groq error', groqRes.status, errBody)
      if (groqRes.status === 429) return res.status(429).json({ error: 'rate_limited' })
      if (groqRes.status === 400 || groqRes.status === 422) return res.status(400).json({ error: 'invalid_audio' })
      return res.status(502).json({ error: 'transcription_failed' })
    }

    const data = (await groqRes.json()) as { text?: string; duration?: number }
    const text = typeof data.text === 'string' ? data.text.trim() : ''

    // Logged even when the transcript comes back empty — Groq was still
    // called and billed for it either way (same principle logApiCost follows
    // for a downstream JSON-parse failure).
    await logAudioCost(userId, 'transcribe', GROQ_MODEL, data.duration ?? 0)

    if (!text) {
      return res.status(422).json({ error: 'empty_transcription' })
    }

    return res.status(200).json({ text })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.error('[transcribe] groq request timed out')
      return res.status(504).json({ error: 'transcription_timeout' })
    }
    console.error('[transcribe] POST', err)
    return res.status(500).json({ error: 'transcription_failed' })
  }
}
