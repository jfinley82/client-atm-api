import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder } from '../../../lib/funnels'
import { cancelLeadOutreach } from '../../../lib/funnelNurture'
import {
  BookingRow,
  LOST_STATUS,
  pickBooking,
  buildContact,
  loadOutcomeTimes,
  loadLatestVideo,
} from '../../../lib/contacts'

// POST /api/leads/[leadId]/outcome — record what happened on the call.
// Body: { outcome: 'won'|'lost'|'no_show', close_amount?: number, notes?: string }
// Returns { contact } in the SAME shape as a GET /api/contacts list row so the
// UI can patch the row in place without refetching the list.
//
// Lead-id-only path, matching the account-level contacts list (there is already
// a funnel-scoped PATCH /api/funnels/[id]/leads/[leadId] for the per-funnel CRM;
// this is the outcome-specific write the contacts surface needs, and it resolves
// the funnel from the lead rather than making the client supply it). Ownership
// is checked through the lead's funnel.
//
// won  -> status 'sold' + close_amount. 'sold' is not a preference: every
//         revenue rollup filters .in('status', ['sold','closed']), so this is
//         what makes the close appear in Overview/Portfolio KPIs.
// lost  -> status 'lost' (migration 075), deliberately OUTSIDE that won filter,
//         so a recorded loss never touches Closed or Revenue.
// no_show -> bookings.attended='no_show' + attendance_marked_at. The lead's own
//         status is left alone: not showing up is not an outcome for the deal,
//         and the nurture engine should keep working them.
export const config = { maxDuration: 30 }

const OUTCOMES = new Set(['won', 'lost', 'no_show'])
const LEAD_COLUMNS =
  'id, funnel_id, email, name, first_name, phone, status, qualification_status, application_status, application_submitted_at, opted_in_at, nurture_pivoted, close_amount, notes, source, created_at'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const leadId = req.query.leadId as string
  if (!leadId) return res.status(400).json({ error: 'leadId required' })

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (!['outcome', 'close_amount', 'notes'].includes(key)) {
      return res.status(400).json({ error: 'unknown_field', field: key })
    }
  }

  const outcome = body.outcome
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
    return res.status(400).json({ error: 'invalid_field', field: 'outcome', allowed: [...OUTCOMES] })
  }

  let closeAmount: number | null | undefined
  if ('close_amount' in body) {
    const v = body.close_amount
    if (v === null) closeAmount = null
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) closeAmount = v
    else return res.status(400).json({ error: 'invalid_field', field: 'close_amount', message: 'must be a non-negative number or null' })
  }

  if ('notes' in body && body.notes !== null && typeof body.notes !== 'string') {
    return res.status(400).json({ error: 'invalid_field', field: 'notes', message: 'must be a string or null' })
  }

  try {
    const { data: lead } = await supabase.from('funnel_leads').select(LEAD_COLUMNS).eq('id', leadId).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Contact not found' })

    const { data: funnel } = await supabase
      .from('funnels')
      .select('id, user_id, subdomain, problem_solution_label, landing_page')
      .eq('id', (lead as any).funnel_id)
      .maybeSingle()
    if (!funnel || (funnel as any).user_id !== userId) return res.status(404).json({ error: 'Contact not found' })

    const priorStatus = (lead as any).status as string | null
    const updates: Record<string, unknown> = {}

    if (outcome === 'won') {
      // A win with no amount is not recordable: close_amount is what the revenue
      // rollups sum, so accepting one would post a close that reads as $0 revenue.
      const effective = closeAmount !== undefined ? closeAmount : (lead as any).close_amount
      const n = typeof effective === 'number' ? effective : Number(effective)
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: 'invalid_field', field: 'close_amount', message: 'won requires a close amount' })
      }
      updates.status = 'sold'
      updates.close_amount = n
    } else if (outcome === 'lost') {
      updates.status = LOST_STATUS
      // close_amount deliberately untouched: nothing was closed, and clearing a
      // previously recorded amount is a separate, explicit edit.
      if (closeAmount !== undefined) updates.close_amount = closeAmount
    }

    if ('notes' in body) updates.notes = body.notes === null ? null : (body.notes as string)

    if (Object.keys(updates).length) {
      const { error } = await supabase.from('funnel_leads').update(updates).eq('id', leadId).eq('funnel_id', (lead as any).funnel_id)
      if (error) throw error
      Object.assign(lead as Record<string, unknown>, updates)
    }

    // Load the bookings either to stamp attendance (no_show) or to shape the
    // returned contact row.
    const { data: bookingRows } = await supabase
      .from('bookings')
      .select('id, funnel_id, email, name, start_time, attended, status, zoom_join_url, meeting_url, custom_answers, created_at')
      .eq('funnel_id', (lead as any).funnel_id)
      // ilike — same case-insensitive match the list uses (bookingKey).
      .ilike('email', (lead as any).email)
    let bookings = (bookingRows || []) as BookingRow[]
    let booking = pickBooking(bookings)

    if (outcome === 'no_show') {
      if (!booking) return res.status(400).json({ error: 'no_booking', message: 'no active booking to mark' })
      // 'no_show', not 'no' — bookings_attended_check allows only
      // ('showed','no_show') and would reject anything else outright.
      const { error } = await supabase
        .from('bookings')
        .update({ attended: 'no_show', attendance_marked_at: new Date().toISOString() })
        .eq('id', booking.id)
      if (error) throw error
      bookings = bookings.map((b) => (b.id === booking!.id ? { ...b, attended: 'no_show' } : b))
      booking = pickBooking(bookings)
    }

    // Log won/lost as a funnel_event so the timeline carries a timestamp —
    // funnel_leads has no closed_at column, this event IS that record. Only on a
    // real transition, so a repeated submit logs nothing. 'lost' is not in the
    // funnel_events vocabulary (and adding it would widen what the analytics
    // event queries scan), so only the won side is logged there.
    // Best-effort: never fail a recorded outcome on the log.
    if (outcome === 'won' && priorStatus !== 'sold') {
      const { error: evErr } = await supabase
        .from('funnel_events')
        .insert({ funnel_id: (lead as any).funnel_id, lead_id: leadId, event_type: 'sold' })
      if (evErr) console.error('[leads/[leadId]/outcome] event log', evErr)
    }

    // A decided lead leaves the nurture sequence. Not for no_show: they still
    // need working, which is the whole point of leaving their status alone.
    if ((outcome === 'won' || outcome === 'lost') && priorStatus !== updates.status) {
      await cancelLeadOutreach(leadId)
    }

    const [wonAtByLead, videoByLead] = await Promise.all([loadOutcomeTimes([leadId]), loadLatestVideo([leadId])])
    const contact = buildContact(
      lead,
      booking,
      funnel as Record<string, any>,
      wonAtByLead.get(leadId) ?? null,
      videoByLead.get(leadId) ?? null,
      Date.now()
    )
    return res.status(200).json({ contact })
  } catch (err) {
    console.error('[leads/[leadId]/outcome] POST', err)
    return res.status(500).json({ error: 'Failed to record outcome' })
  }
}
