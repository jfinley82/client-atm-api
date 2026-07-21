// Lightweight in-memory fixed-window rate limiter for public (unauthenticated)
// endpoints — the funnel lead + event beacons. Best-effort by design: serverless
// instances are ephemeral and not shared, so this throttles a hot instance
// rather than enforcing a global quota. It exists to blunt casual abuse of the
// public write endpoints, not to be a security boundary.
//
// Keyed by an arbitrary string (typically the client IP). Returns true when the
// request is ALLOWED, false when it has exceeded `limit` within `windowMs`.

type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

export function rateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    // Opportunistic cleanup so the map can't grow unbounded on a long-lived
    // instance — drop any windows that have already elapsed.
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k)
    }
    return true
  }

  if (existing.count >= limit) return false
  existing.count += 1
  return true
}

// Best-effort client IP from the standard proxy headers Vercel sets.
export function clientIp(req: any): string {
  const xff = req.headers?.['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff[0] : xff
  if (typeof raw === 'string' && raw.trim()) return raw.split(',')[0].trim()
  return (req.headers?.['x-real-ip'] as string) || req.socket?.remoteAddress || 'unknown'
}
