import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireAdmin } from '../../../../lib/auth'
import { sendTicketUpdateEmail } from '../../../../lib/email'
import {
  isTicketPriority,
  isTicketStage,
  slaFor,
  stageTimestampUpdates,
  NOTIFY_STAGES,
  STAGE_LABELS,
  TICKET_PRIORITIES,
  TICKET_STAGES,
  TicketStage,
} from '../../../../lib/support'

// GET   /api/admin/support/tickets/:id — ticket + full thread, oldest first.
// PATCH /api/admin/support/tickets/:id — stage / priority / assigned_admin_id.
//
// The PATCH is the ONLY way a stage moves, including a Kanban drag. There is no
// silent variant: the same call stamps the SLA timestamps and fires the member
// notification, so a card dragged across a column and a stage picked from the
// detail view can never diverge in what they record or who they tell.
export const config = { maxDuration: 30 }

const TICKET_COLUMNS =
  'id, user_id, category, subject, stage, priority, funnel_id, assigned_admin_id, first_response_at, resolved_at, created_at, updated_at'
const EDITABLE = new Set(['stage', 'priority', 'assigned_admin_id'])

async function loadPeople(ids: (string | null)[]) {
  const real = [...new Set(ids.filter(Boolean))] as string[]
  const byId = new Map<string, { name: string | null; email: string | null }>()
  if (!real.length) return byId
  const { data } = await supabase.from('users').select('id, name, email').in('id', real)
  for (const u of (data || []) as any[]) byId.set(u.id, { name: u.name ?? null, email: u.email ?? null })
  return byId
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    try {
      const { data: ticket } = await supabase.from('support_tickets').select(TICKET_COLUMNS).eq('id', id).maybeSingle()
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' })

      const { data: messages, error: msgErr } = await supabase
        .from('support_ticket_messages')
        .select('id, ticket_id, author_user_id, author_role, body, created_at')
        .eq('ticket_id', id)
        .order('created_at', { ascending: true })
      if (msgErr) throw msgErr

      const rows = (messages || []) as any[]
      const people = await loadPeople([
        (ticket as any).user_id,
        (ticket as any).assigned_admin_id,
        ...rows.map((m) => m.author_user_id),
      ])

      return res.status(200).json({
        ticket: {
          ...(ticket as any),
          member: people.get((ticket as any).user_id) ?? null,
          assigned_admin: (ticket as any).assigned_admin_id ? people.get((ticket as any).assigned_admin_id) ?? null : null,
          stage_label: STAGE_LABELS[(ticket as any).stage as TicketStage] ?? (ticket as any).stage,
          sla: slaFor(ticket as any, Date.now()),
        },
        messages: rows.map((m) => ({ ...m, author: people.get(m.author_user_id) ?? null })),
      })
    } catch (err) {
      console.error('[admin/support/tickets/[id]] GET', err)
      return res.status(500).json({ error: 'Failed to load ticket' })
    }
  }

  if (req.method !== 'PATCH') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (!EDITABLE.has(key)) return res.status(400).json({ error: 'unknown_field', field: key })
  }

  const updates: Record<string, unknown> = {}

  if ('stage' in body) {
    if (!isTicketStage(body.stage)) {
      return res.status(400).json({ error: 'invalid_field', field: 'stage', allowed: TICKET_STAGES })
    }
    updates.stage = body.stage
  }
  if ('priority' in body) {
    if (!isTicketPriority(body.priority)) {
      return res.status(400).json({ error: 'invalid_field', field: 'priority', allowed: TICKET_PRIORITIES })
    }
    updates.priority = body.priority
  }
  if ('assigned_admin_id' in body) {
    const v = body.assigned_admin_id
    if (v === null) {
      updates.assigned_admin_id = null
    } else if (typeof v === 'string' && v.trim()) {
      // Must be a real admin — assigning a ticket to a member would put it in a
      // queue nobody with access ever looks at.
      const trimmed = v.trim()
      const { data: assignee } = await supabase.from('users').select('role').eq('id', trimmed).maybeSingle()
      if (!assignee || (assignee as any).role !== 'admin') {
        return res.status(400).json({ error: 'invalid_field', field: 'assigned_admin_id', message: 'must be an admin user id' })
      }
      updates.assigned_admin_id = trimmed
    } else {
      return res.status(400).json({ error: 'invalid_field', field: 'assigned_admin_id' })
    }
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' })

  try {
    const { data: prior } = await supabase
      .from('support_tickets')
      .select('id, user_id, subject, stage, first_response_at, resolved_at')
      .eq('id', id)
      .maybeSingle()
    if (!prior) return res.status(404).json({ error: 'Ticket not found' })

    const nowIso = new Date().toISOString()
    const nextStage = updates.stage as TicketStage | undefined
    // A genuine transition only — a re-PATCH to the same stage must not restamp
    // first_response_at or re-notify the member.
    const stageChanged = !!nextStage && nextStage !== (prior as any).stage

    if (stageChanged) Object.assign(updates, stageTimestampUpdates(nextStage!, prior as any, nowIso))
    updates.updated_at = nowIso

    const { data: updated, error } = await supabase
      .from('support_tickets')
      .update(updates)
      .eq('id', id)
      .select(TICKET_COLUMNS)
      .maybeSingle()
    if (error) throw error
    if (!updated) return res.status(404).json({ error: 'Ticket not found' })

    // Notify only on a real change, and only for the three stages that ask
    // something of the member or close the loop. Best-effort: the stage change
    // is already recorded, and a mail failure must not undo it.
    if (stageChanged && (NOTIFY_STAGES as readonly string[]).includes(nextStage!)) {
      const { data: member } = await supabase
        .from('users')
        .select('email, name')
        .eq('id', (prior as any).user_id)
        .maybeSingle()
      await sendTicketUpdateEmail({
        email: (member as any)?.email ?? '',
        name: (member as any)?.name ?? null,
        subject: (prior as any).subject,
        // The member-facing label, never the raw enum.
        stageLabel: STAGE_LABELS[nextStage!],
        ticketId: (prior as any).id,
      })
    }

    const people = await loadPeople([(updated as any).user_id, (updated as any).assigned_admin_id])
    return res.status(200).json({
      ticket: {
        ...(updated as any),
        member: people.get((updated as any).user_id) ?? null,
        assigned_admin: (updated as any).assigned_admin_id ? people.get((updated as any).assigned_admin_id) ?? null : null,
        stage_label: STAGE_LABELS[(updated as any).stage as TicketStage] ?? (updated as any).stage,
        sla: slaFor(updated as any, Date.now()),
      },
      notified: stageChanged && (NOTIFY_STAGES as readonly string[]).includes(nextStage!),
    })
  } catch (err) {
    console.error('[admin/support/tickets/[id]] PATCH', err)
    return res.status(500).json({ error: 'Failed to update ticket' })
  }
}
