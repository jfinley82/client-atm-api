import type { VercelRequest } from '@vercel/node'

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
