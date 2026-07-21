import crypto from 'crypto'

// App-layer encryption for calendar refresh tokens at rest. AES-256-GCM with a
// key derived from CALENDAR_TOKEN_KEY (sha256 → 32 bytes, so any key string
// length works). Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>". A refresh
// token must NEVER be written to the DB in plaintext.

export function isTokenKeyConfigured(): boolean {
  return typeof process.env.CALENDAR_TOKEN_KEY === 'string' && process.env.CALENDAR_TOKEN_KEY.length > 0
}

function keyBytes(): Buffer {
  const raw = process.env.CALENDAR_TOKEN_KEY
  if (!raw) throw new Error('CALENDAR_TOKEN_KEY not set')
  return crypto.createHash('sha256').update(raw, 'utf8').digest()
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

// Returns the plaintext, or null if the payload is malformed / the key is wrong /
// the ciphertext was tampered (GCM auth failure). Never throws.
export function decryptToken(payload: string | null | undefined): string | null {
  if (typeof payload !== 'string') return null
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const iv = Buffer.from(parts[1], 'base64')
    const tag = Buffer.from(parts[2], 'base64')
    const enc = Buffer.from(parts[3], 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(enc), decipher.final()])
    return dec.toString('utf8')
  } catch {
    return null
  }
}
