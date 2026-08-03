import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../../lib/funnels'
import { loadSendableContacts } from '../../../../lib/coachContacts'
import { scheduleInviteBroadcast } from '../../../../lib/funnelNurture'

// POST /api/funnels/[id]/invite/send  { consent_confirmed }
//
// Mails the coach's own list this funnel's warm-invite sequence, once.
//
// Consent is a hard gate, not a checkbox we record and ignore: this sends to
// addresses the coach uploaded, so the request is refused outright without an
// explicit confirmation that those people asked to hear from them.
//
// Idempotency is the funnel_invite_broadcasts row, claimed BEFORE any mail goes
// out. Its unique index on funnel_id means a second click loses the insert race
// and returns already_sent — the alternative, checking then inserting, leaves a
// window where two clicks both pass the check and the list gets mailed twice.
export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const funnel = await getOwnedFunnel(userId, id, 'id, user_id, subdomain, warm_invite_emails')
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  if (body.consent_confirmed !== true) {
    return res.status(400).json({
      error: 'consent_required',
      message: 'Confirm these contacts asked to hear from you before sending.',
    })
  }

  // Everything the send needs, checked before anything is claimed or mailed.
  const missing: string[] = []
  if (!funnel.subdomain) missing.push('subdomain')

  const invites = Array.isArray(funnel.warm_invite_emails) ? funnel.warm_invite_emails : []
  if (invites.length === 0) missing.push('warm_invite_emails')

  let contacts: Awaited<ReturnType<typeof loadSendableContacts>> = []
  try {
    contacts = await loadSendableContacts(userId)
  } catch (err) {
    console.error('[funnels/[id]/invite/send] contacts', err)
    return res.status(500).json({ error: 'Failed to load contacts' })
  }
  if (contacts.length === 0) missing.push('contacts')

  if (missing.length) return res.status(400).json({ error: 'not_ready', missing })

  // Claim first. A duplicate here is the second click, not a failure.
  const { data: claimed, error: claimError } = await supabase
    .from('funnel_invite_broadcasts')
    .insert({
      funnel_id: id,
      consent_confirmed: true,
      contact_count: contacts.length,
      status: 'sending',
    })
    .select('id')
    .single()

  if (claimError) {
    const alreadySent = String((claimError as { code?: string }).code) === '23505'
    if (alreadySent) {
      return res.status(409).json({
        error: 'already_sent',
        message: 'This funnel has already broadcast its invites.',
      })
    }
    console.error('[funnels/[id]/invite/send] claim', claimError)
    return res.status(500).json({ error: 'Failed to start the broadcast' })
  }

  try {
    const enrolled = await scheduleInviteBroadcast(funnel, contacts)
    await supabase
      .from('funnel_invite_broadcasts')
      .update({ status: 'sent', contact_count: enrolled })
      .eq('id', claimed.id)

    return res.status(200).json({ ok: true, contact_count: enrolled })
  } catch (err) {
    console.error('[funnels/[id]/invite/send] enroll', err)
    // The claim stays, marked failed. Some mail may already have gone out, so
    // clearing it — and letting a retry mail those people a second time — is
    // worse than requiring a deliberate look at what landed.
    await supabase.from('funnel_invite_broadcasts').update({ status: 'failed' }).eq('id', claimed.id)
    return res.status(500).json({ error: 'Failed to send the broadcast' })
  }
}
