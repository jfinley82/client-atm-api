import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { WON_STATUSES } from '../../lib/contacts'

// GET /api/client-programs/eligible-leads — who the coach could start a program
// for: a lead they have closed, who is not already on one.
//
// CLOSED_AT IS DERIVED, NOT STORED. funnel_leads has close_amount and no close
// timestamp, but funnel_events already records the transition — both writers do
// (api/leads/[leadId]/outcome.ts on the won path, api/funnels/[id]/leads/[leadId].ts
// on a CRM status change), and both are idempotent on a repeat because each
// guards on the status actually changing. So the moment is derivable from
// min(created_at) of that lead's sold/closed events, with no column to add and
// no backfill to invent.
//
// AND IT CAN BE NULL, WHICH MEANS UNKNOWN.
//
// Rows written before those event writes existed carry no event and never will;
// so does a lead whose event insert failed, since both writers are best-effort
// and log rather than throw. "Nothing was recorded" is a different fact from
// "there was nothing to record", and the difference matters here: a lead with no
// derivable close time is still a lead the coach closed and can start a program
// for. It is returned, marked unknown.
//
// It is NOT filtered out — that would hide a real customer because of a missing
// log line. It is NOT given a substitute timestamp either: funnel_leads.updated_at
// is when the row last changed, not when the deal closed, and using it would
// manufacture a value that reads as recorded fact.
export const config = { maxDuration: 30 }

const LEAD_COLUMNS = 'id, funnel_id, email, name, first_name, status, close_amount'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  try {
    const { data: funnels, error: funnelErr } = await supabase.from('funnels').select('id').eq('user_id', userId)
    if (funnelErr) throw funnelErr
    const funnelIds = ((funnels || []) as { id: string }[]).map((f) => f.id)
    // A coach with no funnels has no funnel leads, so nothing is eligible. Unlike
    // the calendar, empty is the honest answer: this list is built from
    // funnel_leads and there is no second source for it.
    if (!funnelIds.length) return res.status(200).json({ leads: [] })

    const [leadsRes, programsRes] = await Promise.all([
      supabase.from('funnel_leads').select(LEAD_COLUMNS).in('funnel_id', funnelIds).in('status', [...WON_STATUSES]),
      // ANY program, whatever its status. uq_client_programs_lead does not filter
      // on status either, so a draft holds the lead just as firmly as an active
      // one — offering it here would produce a create that 409s.
      supabase.from('client_programs').select('lead_id').eq('user_id', userId),
    ])
    if (leadsRes.error) throw leadsRes.error
    if (programsRes.error) throw programsRes.error

    const leads = (leadsRes.data || []) as Record<string, any>[]
    if (!leads.length) return res.status(200).json({ leads: [] })

    const taken = new Set(
      ((programsRes.data || []) as { lead_id: string | null }[]).map((p) => p.lead_id).filter((x): x is string => !!x)
    )

    // One pull for every close event across these leads, rather than N queries.
    const leadIds = leads.map((l) => l.id as string)
    const { data: events, error: eventsErr } = await supabase
      .from('funnel_events')
      .select('lead_id, event_type, created_at')
      .in('lead_id', leadIds)
      .in('event_type', [...WON_STATUSES])
    if (eventsErr) throw eventsErr

    // EARLIEST wins. A lead moved to sold, back, and to sold again has two
    // events; the close happened the first time, and reporting the latest would
    // date the deal from an edit.
    const closedAt = new Map<string, string>()
    for (const e of (events || []) as { lead_id: string; created_at: string }[]) {
      const current = closedAt.get(e.lead_id)
      if (!current || e.created_at < current) closedAt.set(e.lead_id, e.created_at)
    }

    const out = leads
      .filter((l) => !taken.has(l.id as string))
      .map((l) => ({
        lead_id: l.id as string,
        name: displayName(l),
        email: String(l.email || ''),
        close_amount: l.close_amount === null || l.close_amount === undefined ? null : Number(l.close_amount),
        // NULL MEANS UNKNOWN. The frontend renders "closed, date unknown" rather
        // than a blank or a guess.
        closed_at: closedAt.get(l.id as string) ?? null,
      }))
      // Most recently closed first; unknowns last, because an unknown date
      // cannot be sorted into a timeline and putting it at the top would imply
      // it was the most recent.
      .sort((a, b) => {
        if (a.closed_at && b.closed_at) return b.closed_at.localeCompare(a.closed_at)
        if (a.closed_at) return -1
        if (b.closed_at) return 1
        return a.name.localeCompare(b.name)
      })

    return res.status(200).json({ leads: out })
  } catch (err) {
    console.error('[client-programs/eligible-leads]', err)
    return res.status(500).json({ error: 'Failed to load eligible leads' })
  }
}

// NEVER EMPTY. Both name columns can be null on a lead captured by an opt-in
// form that only asked for an address, and an unnamed row is one the coach
// cannot pick out of a list.
function displayName(lead: Record<string, any>): string {
  for (const v of [lead.name, lead.first_name]) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const email = String(lead.email || '')
  return email.split('@')[0] || email
}
