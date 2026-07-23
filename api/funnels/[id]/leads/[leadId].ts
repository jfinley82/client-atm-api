import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { setCors, noStore } from '../../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel, getOwnedLead, ENGAGEMENT_EVENT_TYPES } from '../../../../lib/funnels'
import { cancelLeadOutreach } from '../../../../lib/funnelNurture'

// GET/PATCH /api/funnels/[id]/leads/[leadId] — owner-scoped single-lead detail
// and management.
//   GET   → { lead, activity, note_count } — the lead + its ENGAGEMENT timeline
//           (page views excluded) + the notes-thread count.
//   PATCH → update status (lead|booked|closed) / close_amount / notes. A status
//           transition to booked or closed is also logged as a funnel_event, so
//           the timeline shows the transition with a timestamp.
// Full pipeline the DB funnel_leads_status_check already permits.
const ALLOWED_STATUS = ['lead', 'watching', 'booked', 'showed', 'no_show', 'sold', 'closed']
// Statuses that mean the lead has progressed past the funnel — take them out of
// the nurture flow.
const POST_BOOKING_STATUS = new Set(['booked', 'showed', 'no_show', 'sold', 'closed'])
const EDITABLE_KEYS = new Set(['status', 'close_amount', 'notes'])
const LEAD_COLUMNS = 'id, first_name, email, phone, status, close_amount, notes, opted_in_at, created_at'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  const leadId = req.query.leadId as string
  if (!id || !leadId) return res.status(400).json({ error: 'id and leadId required' })

  // ---- GET: single-lead detail (contact + engagement timeline + note count) ----
  if (req.method === 'GET') {
    noStore(res)
    const lead = await getOwnedLead(userId, id, leadId, LEAD_COLUMNS)
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    try {
      const [activityRes, noteCountRes] = await Promise.all([
        supabase
          .from('funnel_events')
          .select('event_type, created_at')
          .eq('funnel_id', id)
          .eq('lead_id', leadId)
          .in('event_type', ENGAGEMENT_EVENT_TYPES as unknown as string[])
          .order('created_at', { ascending: false }),
        supabase.from('funnel_lead_notes').select('*', { count: 'exact', head: true }).eq('lead_id', leadId),
      ])
      if (activityRes.error) throw activityRes.error
      return res.status(200).json({
        lead,
        activity: activityRes.data || [],
        note_count: noteCountRes.count ?? 0,
      })
    } catch (err) {
      console.error('[funnels/[id]/leads/[leadId]] GET', err)
      return res.status(500).json({ error: 'Failed to load lead' })
    }
  }

  if (req.method !== 'PATCH') return res.status(405).end()

  // Ownership is on the funnel; the update is scoped to funnel_id below so a lead
  // from another funnel can't be touched even with a guessed leadId. We also read
  // the current status here so a genuine transition can be logged as an event.
  const funnel = await getOwnedFunnel(userId, id)
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })
  const { data: prior } = await supabase
    .from('funnel_leads')
    .select('status, close_amount')
    .eq('id', leadId)
    .eq('funnel_id', id)
    .maybeSingle()
  if (!prior) return res.status(404).json({ error: 'Lead not found' })
  const priorStatus = (prior as { status: string | null }).status
  const priorCloseAmount = (prior as { close_amount: unknown }).close_amount

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  // Reject unknown keys rather than silently dropping them.
  for (const key of Object.keys(body)) {
    if (!EDITABLE_KEYS.has(key)) return res.status(400).json({ error: 'unknown_field', field: key })
  }

  const updates: Record<string, unknown> = {}

  if ('status' in body) {
    if (typeof body.status !== 'string' || !ALLOWED_STATUS.includes(body.status)) {
      return res.status(400).json({ error: 'invalid_field', field: 'status', message: `status must be one of ${ALLOWED_STATUS.join(', ')}` })
    }
    updates.status = body.status
  }

  if ('close_amount' in body) {
    const v = body.close_amount
    if (v === null) {
      updates.close_amount = null
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      updates.close_amount = v
    } else {
      return res.status(400).json({ error: 'invalid_field', field: 'close_amount', message: 'must be a non-negative number or null' })
    }
  }

  if ('notes' in body) {
    if (body.notes !== null && typeof body.notes !== 'string') {
      return res.status(400).json({ error: 'invalid_field', field: 'notes', message: 'must be a string or null' })
    }
    updates.notes = body.notes === null ? null : (body.notes as string)
  }

  // 'sold' is a won status that requires a positive close amount — use the
  // incoming close_amount if present, else the lead's existing value.
  if (updates.status === 'sold') {
    const effective = 'close_amount' in body ? updates.close_amount : priorCloseAmount
    if (typeof effective !== 'number' || !Number.isFinite(effective) || effective <= 0) {
      return res.status(400).json({ error: 'invalid_field', field: 'close_amount', message: 'sold requires a close amount' })
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' })
  }

  try {
    const { data, error } = await supabase
      .from('funnel_leads')
      .update(updates)
      .eq('id', leadId)
      .eq('funnel_id', id)
      .select(LEAD_COLUMNS)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Lead not found' })

    // Log a genuine status transition to booked/closed as an engagement event so
    // the lead timeline shows it with a timestamp. Best-effort — never fail the
    // PATCH on the log. Only on a real change (idempotent re-PATCH logs nothing).
    const newStatus = updates.status as string | undefined
    const changed = !!newStatus && newStatus !== priorStatus
    // funnel_events permits booked/closed/sold — log those transitions as events
    // (closed + sold carry revenue). Best-effort.
    if (changed && (newStatus === 'booked' || newStatus === 'closed' || newStatus === 'sold')) {
      const { error: evErr } = await supabase
        .from('funnel_events')
        .insert({ funnel_id: id, lead_id: leadId, event_type: newStatus })
      if (evErr) console.error('[funnels/[id]/leads/[leadId]] status event log', evErr)
    }
    // Any move into a post-booking status takes the lead out of the nurture
    // flow — cancel their queued outreach (nurture + book-a-call), but NOT their
    // booking reminders, which are per booking. Best-effort.
    if (changed && POST_BOOKING_STATUS.has(newStatus as string)) {
      await cancelLeadOutreach(leadId)
    }

    return res.status(200).json({ lead: data })
  } catch (err) {
    console.error('[funnels/[id]/leads/[leadId]] PATCH', err)
    return res.status(500).json({ error: 'Failed to update lead' })
  }
}
