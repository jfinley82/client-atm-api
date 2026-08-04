import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { setCors, noStore } from '../../../../../lib/cors'
import { requireAdmin } from '../../../../../lib/auth'
import { appendTicketMessage } from '../../../../../lib/support'

// POST /api/admin/support/tickets/:id/messages — admin reply, appended to the
// thread.
//
// A reply IS a first response. If this is the first admin message and
// first_response_at is still null, it stamps here — an admin who answers
// without touching the stage has still responded, and the SLA tile must agree
// with what the member actually experienced.
//
// Deliberately does NOT change the stage, and therefore sends no email: the
// stage is the admin's explicit signal about who the ticket is waiting on, and
// inferring "waiting_on_member" from the existence of a reply would mail people
// for internal notes. Replying and then setting the stage is two actions.
export const config = { maxDuration: 30 }

const BODY_MAX = 10000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const raw = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const body = typeof raw.body === 'string' ? raw.body.trim() : ''
  if (!body) return res.status(400).json({ error: 'invalid_field', field: 'body', message: 'body is required' })
  if (body.length > BODY_MAX) {
    return res.status(400).json({ error: 'invalid_field', field: 'body', message: `max ${BODY_MAX} characters` })
  }

  try {
    const { data: ticket } = await supabase
      .from('support_tickets')
      .select('id, first_response_at')
      .eq('id', id)
      .maybeSingle()
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' })

    const nowIso = new Date().toISOString()

    const appended = await appendTicketMessage({ ticketId: id, authorUserId: adminId, authorRole: 'admin', body })
    if (!appended) return res.status(500).json({ error: 'Failed to post reply' })

    // Stamp only when nothing has been recorded yet — a second reply must not
    // move a first response that already happened.
    const stampsFirstResponse = !(ticket as any).first_response_at
    const { error: updErr } = await supabase
      .from('support_tickets')
      .update({ ...(stampsFirstResponse ? { first_response_at: nowIso } : {}), updated_at: nowIso })
      .eq('id', id)
    if (updErr) console.error('[admin/support/tickets/[id]/messages] ticket stamp', updErr)

    const { data: author } = await supabase.from('users').select('name, email').eq('id', adminId).maybeSingle()

    return res.status(201).json({
      message: { ...appended.message, author: { name: (author as any)?.name ?? null, email: (author as any)?.email ?? null } },
      first_response_stamped: stampsFirstResponse,
    })
  } catch (err) {
    console.error('[admin/support/tickets/[id]/messages] POST', err)
    return res.status(500).json({ error: 'Failed to post reply' })
  }
}
