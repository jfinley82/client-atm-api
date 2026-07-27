import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { rateLimit } from '../../lib/rateLimit'
import { loadCoachBrand, linkifyEmailBody, brandedEmailHtml, sendOneOffEmail } from '../../lib/email'
import { logEvent } from '../../lib/apiCostLog'

// POST /api/email/test — send ONE coach-branded email to a coach-chosen inbox so
// they can preview a funnel/nurture email exactly as it will land. requireActiveUser.
// Body: { to, name?, subject, body }. The frontend passes the currently-shown
// (possibly-edited) subject/body so the test matches what the coach sees.
//
// Rendered like a real send: coach brand (loadCoachBrand), the body run through
// linkifyEmailBody so [BOOK_A_CALL_LINK]/[TRAINING_LINK]/[REGISTER_LINK]/[OFFER_LINK]
// resolve, wrapped in brandedEmailHtml. There is NO lead here, so NO watch/lead
// tokens are minted — links use the coach's real funnel base when they have one,
// else a harmless preview URL. Subject is prefixed [Test] so it's unmistakable.
export const config = { maxDuration: 15 }

const FROM_ADDRESS = 'noreply@mail.microtrainingmethod.com'
const FUNNEL_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'
const BODY_MAX = 20_000
const SUBJECT_MAX = 500
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// Merge the recipient's first name into any [name]/{{name}} token the copy uses,
// exactly as a real send would resolve it (blank name -> a neutral "there"). A
// no-op for the current generator output, which does not personalize by name.
function mergeName(text: string, firstName: string): string {
  return text
    .replace(/\[(?:first_?name|name)\]/gi, firstName)
    .replace(/\{\{\s*(?:first_?name|name)\s*\}\}/gi, firstName)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // 5 test sends / minute / user — a clean 429 to blunt abuse.
  if (!rateLimit(`email_test:${userId}`, 5, 60_000)) {
    return res.status(429).json({ error: 'Too many test emails. Try again in a minute.' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const to = typeof body.to === 'string' ? body.to.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject : ''
  const emailBody = typeof body.body === 'string' ? body.body : ''

  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'A valid recipient email is required.' })
  if (subject.trim().length === 0) return res.status(400).json({ error: 'Subject is required.' })
  if (subject.length > SUBJECT_MAX) return res.status(400).json({ error: `Subject is too long (max ${SUBJECT_MAX}).` })
  if (emailBody.trim().length === 0) return res.status(400).json({ error: 'Body is required.' })
  if (emailBody.length > BODY_MAX) return res.status(400).json({ error: `Body is too long (max ${BODY_MAX} characters).` })

  try {
    const brand = await loadCoachBrand(userId)

    // Real book-a-call/training/register URLs from the coach's funnel subdomain
    // when they have one; else a harmless preview base. No lead => no minted
    // watch/lead tokens, just the tokenless public pages.
    let base = `https://${FUNNEL_DOMAIN}`
    const funnelRes = await supabase
      .from('funnels')
      .select('subdomain')
      .eq('user_id', userId)
      .not('subdomain', 'is', null)
      .limit(1)
    const subdomain = funnelRes.data?.[0]?.subdomain
    if (typeof subdomain === 'string' && subdomain.trim()) base = `https://${subdomain.trim()}.${FUNNEL_DOMAIN}`
    const bookUrl = `${base}/?page=book`
    const trainingUrl = `${base}/?page=training`
    const registerUrl = `${base}/`

    const firstName = name ? name.split(/\s+/)[0] : 'there'
    const mergedSubject = mergeName(subject, firstName)
    const mergedBody = mergeName(emailBody, firstName)

    // Match the real send's CTA button: book emails point at the book page,
    // training emails at the training, register emails at the opt-in page.
    let cta: { label: string; url: string } | undefined
    if (/\[BOOK_A_CALL_LINK\]|\[OFFER_LINK\]/.test(emailBody)) cta = { label: 'Book your call', url: bookUrl }
    else if (/\[TRAINING_LINK\]/.test(emailBody)) cta = { label: 'Watch the training', url: trainingUrl }
    else if (/\[REGISTER_LINK\]/.test(emailBody)) cta = { label: 'Register', url: registerUrl }

    const bodyHtml = linkifyEmailBody(mergedBody, bookUrl, trainingUrl, registerUrl)
    const html = brandedEmailHtml(brand, { heading: mergedSubject, bodyHtml, cta })

    const messageId = await sendOneOffEmail({
      from: `${brand.fromName} <${FROM_ADDRESS}>`,
      to,
      replyTo: brand.replyTo,
      subject: `[Test] ${mergedSubject}`,
      html,
    })

    // Volume telemetry only (email is not token-billed): tool_type 'email_test'.
    await logEvent(userId, 'email_test', 'resend')

    return res.status(200).json({ ok: true, messageId })
  } catch (err) {
    console.error('[email/test] send failed', err)
    return res.status(502).json({ error: 'Failed to send the test email. Try again.' })
  }
}
