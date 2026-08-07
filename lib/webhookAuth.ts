import type { VercelRequest, VercelResponse } from '@vercel/node'

// UNREFERENCED AS OF 2026-08-07, AND DELIBERATELY KEPT UNTIL 2026-08-21.
//
// Its five callers under api/members/** were retired to 410 the same day, and
// the 410 is returned before any auth check, so nothing in this codebase reads
// WEBHOOK_SECRET any more. It is kept for two weeks alongside those stubs so
// that if a surviving caller announces itself in the [deprecated-410] logs,
// restoring an endpoint is a revert rather than a rewrite. Delete this file
// with the last of them.
//
// ─────────────────────────────────────────────────────────────────────────────
//
// The shared-secret gate for the GoHighLevel webhooks under api/members/**.
//
// WHY THIS IS A FUNCTION AND NOT FIVE COPIES OF TWO LINES.
//
// Every one of those handlers used to open with:
//
//     if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
//       return res.status(401).json({ error: 'Unauthorized' })
//     }
//
// which is a gate right up until WEBHOOK_SECRET is unset. Then both sides are
// `undefined`, `undefined !== undefined` is false, and every endpoint opens to
// anyone — including suspend (disable any member) and create-paid (grant paid
// access). A missing environment variable silently converting a closed door
// into an open one is the worst shape a gate can have: nothing fails, nothing
// logs, and the endpoint keeps answering 200.
//
// That is not hypothetical here. The db-migrate workflow ran with an empty
// DATABASE_URL for days and eight consecutive failures went unnoticed, so
// "someone would spot it" is not a control this project has earned.
//
// api/webhooks/resend.ts and api/zoom/webhook.ts already refuse when their
// secret is missing. This makes that the rule rather than the exception, in one
// place, so the sixth handler to need it inherits the behaviour instead of
// copying the two lines and forgetting the third.
//
// Returns TRUE when the caller may proceed. On failure it has already written
// the response — same usage shape as requireCapability:
//
//     if (!requireWebhookSecret(req, res, 'members/suspend')) return

export function requireWebhookSecret(req: VercelRequest, res: VercelResponse, label: string): boolean {
  const secret = process.env.WEBHOOK_SECRET

  // MISSING SECRET IS A SERVER FAULT, NOT A CLIENT ONE. 500, not 401: the
  // caller did nothing wrong and retrying with a different header will not
  // help. It also reads differently in logs and alerting from a genuine bad
  // credential, which is the whole point — a misconfigured environment should
  // look like a misconfigured environment.
  if (!secret) {
    console.error(`[${label}] WEBHOOK_SECRET not set — refusing every request rather than accepting all of them`)
    res.status(500).json({ error: 'webhook_not_configured' })
    return false
  }

  const provided = req.headers['x-webhook-secret']
  if (typeof provided !== 'string' || provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }

  return true
}
