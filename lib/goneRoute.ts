import type { VercelRequest, VercelResponse } from '@vercel/node'

// 410 Gone for a retired endpoint, and the one log line that tells us whether
// anyone is still calling it.
//
// WHY 410 AND NOT DELETE. A deleted route 404s, which reads like a typo and
// tells a surviving caller nothing. These five granted paid tiers and suspended
// accounts; if some legacy automation still POSTs to create-paid, the failure
// mode of a silent 404 is that someone pays and gets nothing, discovered by
// email a week later. 410 is unambiguous — this existed, it is gone, stop
// calling it — and the log line means the caller announces itself to us rather
// than breaking into silence. Same call api/cards/index.ts made.
//
// WHY THE STATUS COMES FIRST. Before any auth check, any body parse, any
// database access. The capability has to disappear immediately, and the way to
// be sure of that is for there to be no code after the status line that could
// reach a table.
//
// NOTE: deliberately NO setCors. api/cards/index.ts calls it, but these five
// never had CORS — which is exactly why browser POSTs against them failed at
// that layer. Adding it now would grant a new capability to a route being
// retired, which is the wrong direction, and it would make OPTIONS short
// circuit to 204 instead of 410. Without it EVERY method gets 410 with no
// carve-out. Server-to-server callers, which is all these ever had, do not
// send preflights and see the 410 fine; a browser caller still reaches us and
// is still logged, it just cannot read the body — and the log is the part we
// need.

export type GoneOptions = {
  /** Short route label for the log line, e.g. 'members/suspend'. */
  label: string
  /** What the caller should do instead. Goes in the response body. */
  useInstead: string
  /** ISO date after which the file itself may be deleted. */
  removeAfter: string
}

export function respondGone(req: VercelRequest, res: VercelResponse, opts: GoneOptions): void {
  const h = req.headers

  // Everything needed to identify a surviving caller, and nothing that would
  // put a credential in a log. The x-webhook-secret header is reported as
  // PRESENT OR ABSENT ONLY — never its value, not even a prefix or a length,
  // because a log is a place secrets outlive the systems that used them.
  const forwarded = h['x-forwarded-for']
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || h['x-real-ip'] || 'unknown'

  console.warn(
    `[deprecated-410] ${opts.label}`,
    JSON.stringify({
      method: req.method,
      path: req.url,
      ip,
      user_agent: h['user-agent'] || 'unknown',
      // Presence is the useful signal: a caller sending the header is a real
      // integration that still believes in this endpoint, not a scanner.
      webhook_secret_header: h['x-webhook-secret'] !== undefined ? 'present' : 'absent',
    })
  )

  res.status(410).json({
    error: 'gone',
    message: `This endpoint has been retired. ${opts.useInstead}`,
    remove_after: opts.removeAfter,
  })
}
