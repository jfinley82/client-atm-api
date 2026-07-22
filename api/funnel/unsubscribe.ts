import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { verifyUnsubscribeToken } from '../../lib/funnelLeadToken'
import { cancelLeadQueue } from '../../lib/funnelNurture'

// GET /api/funnel/unsubscribe?token=… — PUBLIC one-click unsubscribe from a
// funnel's nurture emails. The token (signed by lib/funnelLeadToken with the
// distinct 'unsub' purpose, 1-year TTL) names the (funnel, lead). We set
// email_unsubscribed and cancel the lead's still-scheduled queue at Resend.
// Always renders a friendly HTML page; a bad/expired token just says the link is
// invalid (never leaks whether a lead exists).
function page(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F4F6F9;color:#0B1120;">
  <div style="max-width:520px;margin:0 auto;padding:64px 24px;text-align:center;">
    <h1 style="font-size:22px;margin:0 0 12px;">${title}</h1>
    <p style="font-size:15px;line-height:24px;color:#4B5563;margin:0;">${message}</p>
  </div>
</body></html>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')

  const rawToken = req.query?.token
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken
  const decoded = verifyUnsubscribeToken(token)
  if (!decoded) {
    return res.status(400).send(page('Link expired', 'This unsubscribe link is no longer valid. If you keep receiving emails, please reply to one and ask to be removed.'))
  }

  try {
    // Scope the update to (lead, funnel) so a token can only unsubscribe its own
    // lead. Missing lead → still show success (never reveal existence).
    await supabase
      .from('funnel_leads')
      .update({ email_unsubscribed: true })
      .eq('id', decoded.leadId)
      .eq('funnel_id', decoded.funnelId)
    await cancelLeadQueue(decoded.leadId)
  } catch (err) {
    console.error('[funnel/unsubscribe]', err)
    // Fall through to the success page — the important part (the flag) is
    // idempotent and best-effort; we don't want to bounce the reader to an error.
  }

  return res.status(200).send(page("You're unsubscribed", "You won't receive any more emails from this training. You can close this tab."))
}
