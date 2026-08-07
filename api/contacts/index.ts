import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { loadOwnedActiveBookings } from '../../lib/coachBookings'
import {
  STAGES,
  Stage,
  BookingRow,
  Contact,
  buildBookingIndex,
  pickBooking,
  buildContact,
  loadOutcomeTimes,
  loadLatestVideo,
} from '../../lib/contacts'

// GET /api/contacts — every contact across ALL the coach's funnels.
//
// Query: funnel_id, stage, q (name/email search), sort, page, limit.
// Response: { stage_counts, contacts, page: { page, limit, total } }
//
// Ownership is resolved ONCE (funnels.user_id = caller) and every query below is
// scoped to that id set — RLS is off by design in this schema (API-layer auth),
// so this scoping IS the access control.
//
// Stage is DERIVED (see lib/contacts.ts), not a column, so neither the stage
// filter nor stage_counts can be pushed into SQL: the owner's leads are read,
// derived, counted, then filtered/sorted/paginated in memory. Bounded by
// MAX_SCAN so one enormous account can't run the function out of memory; the
// response says when that bound was hit rather than silently truncating.
export const config = { maxDuration: 30 }

const MAX_SCAN = 5000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SORTS = new Set(['recent', 'created', 'name', 'value'])

const LEAD_COLUMNS =
  'id, funnel_id, email, name, first_name, phone, status, qualification_status, application_status, application_submitted_at, opted_in_at, nurture_pivoted, close_amount, source, created_at'

function intParam(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(Array.isArray(v) ? v[0] : v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback
  return n
}

function strParam(v: unknown): string {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s.trim() : ''
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const funnelFilter = strParam(req.query.funnel_id)
  const stageFilter = strParam(req.query.stage)
  const q = strParam(req.query.q).toLowerCase()
  const sort = SORTS.has(strParam(req.query.sort)) ? strParam(req.query.sort) : 'recent'
  const page = intParam(req.query.page, 1, 1, 100000)
  const limit = intParam(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)

  if (stageFilter && stageFilter !== 'all' && !STAGES.includes(stageFilter as Stage)) {
    return res.status(400).json({ error: 'invalid_field', field: 'stage', allowed: ['all', ...STAGES] })
  }

  try {
    const { data: funnels, error: funnelErr } = await supabase
      .from('funnels')
      .select('id, subdomain, problem_solution_label, landing_page, booking_questions')
      .eq('user_id', userId)
    if (funnelErr) throw funnelErr

    const owned = (funnels || []) as Record<string, any>[]
    const byFunnel = new Map(owned.map((f) => [f.id as string, f]))
    // A funnel_id filter naming a funnel the caller does not own resolves to an
    // empty scope rather than a 403 — the same "indistinguishable from missing"
    // stance getOwnedFunnel takes.
    const funnelIds = funnelFilter ? owned.filter((f) => f.id === funnelFilter).map((f) => f.id) : owned.map((f) => f.id)

    const empty = {
      stage_counts: { all: 0, ...Object.fromEntries(STAGES.map((s) => [s, 0])) },
      contacts: [] as Contact[],
      page: { page, limit, total: 0 },
    }
    // A coach with no funnels has no CONTACTS — this list is built from
    // funnel_leads, and a coach-page booking creates no lead. Returning empty is
    // correct here, unlike the calendar, where it hid real calls.
    if (!funnelIds.length) return res.status(200).json(empty)

    const [leadsRes, allBookings] = await Promise.all([
      supabase
        .from('funnel_leads')
        .select(LEAD_COLUMNS)
        .in('funnel_id', funnelIds)
        .order('created_at', { ascending: false })
        .limit(MAX_SCAN),
      // BOTH ownership arms — see lib/coachBookings.ts. Scoped funnel-only, a
      // rebooked call made through the coach's own page never reached the
      // contact it belongs to.
      //
      // 'active', not 'any': this list feeds the set straight into pickBooking,
      // which discards canceled rows, and nothing else here reads them — so
      // fetching them would be dead weight. The DETAIL view does need 'any',
      // because its timeline renders "Call canceled" as an event. Verified by
      // mutation: flipping this makes no observable difference, flipping the
      // detail view's does.
      //
      // A funnel_id filter narrows funnelIds, but the coach arm is keyed on the
      // caller, so it would still return calls from every funnel. Refined to the
      // selected funnel's leads below rather than here: a coach-page booking has
      // no funnel to filter on, so the narrowing has to happen where the lead is
      // known.
      loadOwnedActiveBookings<BookingRow>({
        userId,
        funnelIds,
        columns: 'id, funnel_id, email, name, start_time, attended, status, zoom_join_url, meeting_url, custom_answers, created_at',
        status: 'active',
      }),
    ])
    if (leadsRes.error) throw leadsRes.error

    const leads = (leadsRes.data || []) as Record<string, any>[]
    if (!leads.length) return res.status(200).json(empty)

    // bookings has no lead_id, so the match is (funnel_id, lower(email)) for a
    // funnel booking and email alone for a coach-page one — see
    // buildBookingIndex, which owns that rule for every contacts surface.
    const bookingsFor = buildBookingIndex(leads, allBookings)

    const leadIds = leads.map((l) => l.id as string)
    const [wonAtByLead, videoByLead] = await Promise.all([loadOutcomeTimes(leadIds), loadLatestVideo(leadIds)])

    const now = Date.now()
    const all: Contact[] = leads.map((lead) => {
      const booking = pickBooking(bookingsFor(lead))
      return buildContact(lead, booking, byFunnel.get(lead.funnel_id as string), wonAtByLead.get(lead.id as string) ?? null, videoByLead.get(lead.id as string) ?? null, now)
    })

    // Counts are over the SEARCH result but before the stage filter, so the
    // stage chips keep showing what is available to switch to instead of
    // collapsing to the selected one.
    const searched = q
      ? all.filter((c) => c.email.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
      : all

    const stage_counts: Record<string, number> = { all: searched.length, ...Object.fromEntries(STAGES.map((s) => [s, 0])) }
    for (const c of searched) stage_counts[c.stage] = (stage_counts[c.stage] || 0) + 1

    const filtered = stageFilter && stageFilter !== 'all' ? searched.filter((c) => c.stage === stageFilter) : searched

    filtered.sort((a, b) => {
      if (sort === 'name') return (a.name || a.email).localeCompare(b.name || b.email)
      if (sort === 'value') return (b.value ?? -1) - (a.value ?? -1)
      // 'recent' (default) = newest activity; 'created' falls back to the same
      // ordering the leads query already applied.
      const at = a.last_activity.at || ''
      const bt = b.last_activity.at || ''
      return bt.localeCompare(at)
    })

    const start = (page - 1) * limit
    return res.status(200).json({
      stage_counts,
      contacts: filtered.slice(start, start + limit),
      page: { page, limit, total: filtered.length },
      // Only present when the scan bound was reached — an explicit signal that
      // counts describe the newest MAX_SCAN leads rather than the whole account.
      ...(leads.length >= MAX_SCAN ? { truncated: { scanned: leads.length, limit: MAX_SCAN } } : {}),
    })
  } catch (err) {
    console.error('[contacts] GET', err)
    return res.status(500).json({ error: 'Failed to load contacts' })
  }
}
