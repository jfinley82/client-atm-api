import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireActiveUser } from '../../lib/auth'
import { sendTicketReceivedEmail } from '../../lib/email'
import { appendTicketMessage, isTicketCategory, slaFor, STAGE_LABELS, TICKET_CATEGORIES, TicketStage } from '../../lib/support'

// Member-facing support tickets.
//
// POST /api/support/tickets  { category, subject, message, funnel_id? }
//   Creates the ticket AND its first thread message in one call, then sends the
//   one-time received confirmation.
// GET  /api/support/tickets
//   The caller's own tickets, newest first.
//
// Identity comes from the auth token — there are deliberately no name/email
// fields. The member is logged in; asking them to retype what we already know
// invites a typo'd address that then never receives the confirmation.
export const config = { maxDuration: 30 }

const SUBJECT_MAX = 200
const MESSAGE_MAX = 10000

const TICKET_COLUMNS =
  'id, user_id, category, subject, stage, priority, funnel_id, assigned_admin_id, first_response_at, resolved_at, created_at, updated_at'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('support_tickets')
        .select(TICKET_COLUMNS)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
      if (error) throw error

      const now = Date.now()
      return res.status(200).json({
        tickets: (data || []).map((t: any) => ({
          ...t,
          // The member sees the label, never the raw stage value.
          stage_label: STAGE_LABELS[t.stage as TicketStage] ?? t.stage,
          sla: slaFor(t, now),
        })),
      })
    } catch (err) {
      console.error('[support/tickets] GET', err)
      return res.status(500).json({ error: 'Failed to load tickets' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  if (!isTicketCategory(body.category)) {
    return res.status(400).json({ error: 'invalid_field', field: 'category', allowed: TICKET_CATEGORIES })
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  if (!subject) return res.status(400).json({ error: 'invalid_field', field: 'subject', message: 'subject is required' })
  if (subject.length > SUBJECT_MAX) {
    return res.status(400).json({ error: 'invalid_field', field: 'subject', message: `max ${SUBJECT_MAX} characters` })
  }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return res.status(400).json({ error: 'invalid_field', field: 'message', message: 'message is required' })
  if (message.length > MESSAGE_MAX) {
    return res.status(400).json({ error: 'invalid_field', field: 'message', message: `max ${MESSAGE_MAX} characters` })
  }

  // Optional funnel context. Scoped to the caller's own funnels: an id they do
  // not own is dropped rather than rejected, since it is context the form
  // supplied rather than something the member typed and can fix.
  let funnelId: string | null = null
  if (typeof body.funnel_id === 'string' && body.funnel_id.trim()) {
    const { data: funnel } = await supabase
      .from('funnels')
      .select('id')
      .eq('id', body.funnel_id.trim())
      .eq('user_id', userId)
      .maybeSingle()
    funnelId = (funnel as any)?.id ?? null
  }

  try {
    const { data: ticket, error } = await supabase
      .from('support_tickets')
      .insert({ user_id: userId, category: body.category, subject, funnel_id: funnelId })
      .select(TICKET_COLUMNS)
      .single()
    if (error) throw error

    // The description IS the first message in the thread, not a separate field.
    const appended = await appendTicketMessage({
      ticketId: (ticket as any).id,
      authorUserId: userId,
      authorRole: 'member',
      body: message,
    })
    // A ticket with no body is not usable by whoever picks it up, so this is
    // not best-effort — roll the ticket back rather than leave a subject-only
    // row that looks answerable but isn't.
    if (!appended) {
      await supabase.from('support_tickets').delete().eq('id', (ticket as any).id)
      throw new Error('failed to store initial ticket message')
    }

    const { data: user } = await supabase.from('users').select('email, name').eq('id', userId).maybeSingle()
    await sendTicketReceivedEmail({
      email: (user as any)?.email ?? '',
      name: (user as any)?.name ?? null,
      subject,
      ticketId: (ticket as any).id,
    })

    return res.status(201).json({
      ticket: {
        ...(ticket as any),
        stage_label: STAGE_LABELS[(ticket as any).stage as TicketStage] ?? (ticket as any).stage,
        sla: slaFor(ticket as any, Date.now()),
      },
    })
  } catch (err) {
    console.error('[support/tickets] POST', err)
    return res.status(500).json({ error: 'Failed to create ticket' })
  }
}
