import type { VercelRequest, VercelResponse } from '@vercel/node'
import { respondGone } from '../../lib/goneRoute'

// RETIRED 2026-08-07 — GoHighLevel is no longer connected to this project, and
// this was part of that integration and nothing else. It could create users,
// and the set it belonged to could also grant paid tiers and suspend accounts,
// so leaving it live as dead code meant carrying that capability for no caller.
//
// Not deleted outright: seven days of logs showing no successful call is not
// proof of never, and a 404 would tell a surviving automation nothing. 410 says
// what happened, and lib/goneRoute.ts logs the caller so it announces itself
// instead of failing into silence. That matters most for create-paid, where a
// silent failure means someone pays and gets nothing.
//
// DELETE THIS FILE AFTER 2026-08-21 if [deprecated-410] never appears in the
// runtime logs. lib/webhookAuth.ts and lib/goneRoute.ts go with the last of
// them. This note exists so it is a dated decision rather than a stub nobody
// dares remove.
//
// The gate is GONE, not bypassed: the 410 is returned before any auth check,
// any body parse and any database access, so WEBHOOK_SECRET is no longer read
// by this file — or by anything else in the codebase.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  return respondGone(req, res, {
    label: 'members/resume',
    useInstead: 'Use PATCH /api/admin/members/[id] with { "status": "active" }.',
    removeAfter: '2026-08-21',
  })
}
