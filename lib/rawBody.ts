import type { VercelRequest, VercelResponse } from '@vercel/node'

// Raw request bodies, read once and correctly, for every endpoint that runs with
// `bodyParser: false`.
//
// THE CEILING NOTHING HERE CAN RAISE. Vercel caps a serverless function's
// request body at roughly 4.5MB, and it enforces that at the edge — the function
// is never invoked, so no handler code runs and no handler-written status is
// ever sent. The client sees a transport-level failure with no body to read.
//
// Measured on production against f128f0b: a 4MB body returned 200 and stored;
// a 5MB body failed at the fetch level in 1.35s, FASTER than the 4MB success.
// That timing is the proof — it died at the edge before the transfer finished,
// rather than being read and rejected by us.
//
// The consequence is that any MAX_BYTES above this number is unreachable code
// pretending to be a limit. This repo previously declared 5MB (avatar, hub
// cover), 10MB (forum image, slide image, guide PDF) and 20MB (transcribe) —
// none of which could ever fire. What members actually got instead was an
// unexplained network error.
//
// So every raw-body limit now sits BELOW the platform cap. That removes no
// capability, because the capability was never there: it converts a silent
// transport failure into an accurate, readable message. For anything that
// genuinely needs to be larger than this, the function has to leave the
// transfer path entirely — see lib/uploadUrl.ts.
export const PLATFORM_BODY_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024)

// The limit every direct-to-function upload uses. Under the platform cap with
// enough headroom that the margin is not a rounding argument.
export const DIRECT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024

export const DIRECT_UPLOAD_MAX_LABEL = '4MB'

// The status every "too large" refusal answers with, everywhere.
//
// This module already owned the number and the message. It owns the status for
// the same reason: seven endpoints share one condition, and before this they
// disagreed about it — forum/upload-image and slides/upload-image returned 413
// while auth/upload-avatar, guide/publish, hub cover, transcribe and pdf/render
// returned 400. Every message was correct and readable, so nothing was
// member-facing; it bites the first time a frontend writes
// `if (res.status === 413)` and gets it right on two endpoints out of seven.
//
// Collapsing six copies of readBoundedBody into one removed the drift in the
// size dimension. Leaving the status behind would just have opened a new one.
//
// 413 rather than 400 because that is what the condition means, because it is
// what the two most recently written endpoints already used, and because it is
// what Supabase itself reports for an oversize object — see the note in
// lib/uploadUrl.ts about it doing so inside a 400.
export const UPLOAD_TOO_LARGE_STATUS = 413

/** The standard prose refusal. `noun` is the thing being uploaded: 'Image', 'PDF'. */
export function tooLargeMessage(noun: string): string {
  return `${noun} must be ${DIRECT_UPLOAD_MAX_LABEL} or smaller`
}

/**
 * Answer a too-large body. Every caller goes through here so the status cannot
 * drift again; the message stays the caller's, because transcribe speaks in
 * machine codes and pdf/render is not talking about a file.
 */
export function respondTooLarge(res: VercelResponse, error: string) {
  return res.status(UPLOAD_TOO_LARGE_STATUS).json({ error })
}

/**
 * Read the request body into a Buffer, bounded at maxBytes.
 *
 * Once over the limit it STOPS ACCUMULATING but keeps draining, rather than
 * calling req.destroy(). Destroying tears down the RESPONSE along with the
 * request stream, so the 413 the caller writes is never flushed — fetch rejects
 * with a network error and the member gets a generic failure on precisely the
 * case that needs explaining. Confirmed on production.
 *
 * The trade is bandwidth, not memory: the buffer is released the moment the
 * limit is passed and nothing further is retained, so an oversized upload still
 * cannot be accumulated unbounded. It just finishes transferring before being
 * told no.
 *
 * Rejects with Error('file_too_large'); every caller keys off that message.
 */
export function readBoundedBody(
  req: VercelRequest,
  maxBytes: number = DIRECT_UPLOAD_MAX_BYTES
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        if (!tooLarge) {
          tooLarge = true
          chunks = [] // drop what we have; memory stays bounded at maxBytes
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => (tooLarge ? reject(new Error('file_too_large')) : resolve(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}
