import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { loadOwnedActiveBookings } from '../../lib/coachBookings'
import { funnelDisplayName } from '../../lib/contacts'
import { buildLeadResolver, needsOutcome, approvedNotBooked, noActivity } from '../../lib/coachQueues'
import { isStalled, sessionsUsed, type ItemRow, type ProgramRow, type ProgramBookingRow } from '../../lib/clientProgramSerializers'
import {
  attentionStrip,
  relativeDay,
  bookRate,
  callsReconciliation,
  serializeClients,
  serializeMethod,
  LEAD_LIST_LIMIT,
  UPCOMING_LIMIT,
  REQUEST_LIST_LIMIT,
  type AttentionKey,
} from '../../lib/dashboardSerializers'

// GET /api/dashboard/my-business — the whole My Business dashboard, in one call.
//
// ONE ENDPOINT, AND THE PAYLOAD ARGUMENT IS THE SECOND REASON.
//
// Composing this from /api/calendar + /api/contacts + /api/funnels/portfolio +
// /api/client-programs would scan funnel_leads THREE times and bookings THREE
// times (six queries, two per call through the ownership helper), and
// api/funnels/portfolio.ts pulls EVERY landing_view row ever recorded to count
// visitors — uncapped, 50,000 rows for one number at 50,000 views. It would also
// ship a coach's entire contact book to render nine numbers and twelve rows.
//
// This endpoint needs no funnel_events query at all: the funnel panel shows
// leads / booked / book-rate and no visitor count, so the unbounded scan is not
// replaced with head-counts, it is simply not needed.
//
// THE OWNERSHIP RULE IS NOT RE-IMPLEMENTED HERE. A dashboard is a fan-in, and a
// fan-in is where a fifth copy of a scoping rule gets written because importing
// the fourth was inconvenient. Bookings come from lib/coachBookings.ts, the work
// queues from lib/coachQueues.ts, the client derivations from
// lib/clientProgramSerializers.ts, and the shaping from
// lib/dashboardSerializers.ts. Nothing below invents a predicate.
export const config = { maxDuration: 30 }

const LEAD_COLUMNS =
  'id, funnel_id, email, name, first_name, status, application_status, application_submitted_at, created_at'
const BOOKING_COLUMNS = 'id, funnel_id, coach_user_id, email, name, start_time, end_time, attended, status'
const PROGRAM_COLUMNS =
  'id, user_id, lead_id, client_name, client_email, client_timezone, program_name, total_weeks, sessions_allowed, start_date, status, portal_token_version, portal_last_opened_at, activated_at, completed_at'
const ITEM_COLUMNS =
  'id, program_id, kind, sequence_position, source_week, sort_order, title, detail, phase_name, due_date, status, completed_at, completed_by'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Typed rather than Record<string, any>, so the shared queue predicates keep this
// caller's shape instead of being cast in and out of the narrow one.
type DashBooking = {
  id: string
  funnel_id: string | null
  coach_user_id: string | null
  email: string
  name: string | null
  start_time: string | null
  end_time: string | null
  attended: string | null
  status: string | null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const today = nowIso.slice(0, 10)

  try {
    // Funnels first: they scope the lead read, and their ids are the only thing
    // the rest of the fan-in needs before it can start.
    const { data: funnelRows, error: funnelErr } = await supabase
      .from('funnels')
      .select('id, subdomain, problem_solution_label, landing_page, status')
      .eq('user_id', userId)
    if (funnelErr) throw funnelErr
    const funnels = (funnelRows || []) as Record<string, any>[]
    const funnelIds = funnels.map((f) => f.id as string)

    const [leadsRes, bookings, programsRes, settingsRes, frameworkRes, offersRes, blueprintsRes] = await Promise.all([
      // NO EARLY RETURN ON ZERO FUNNELS. A coach with a booking page and no
      // funnel still has calls, clients and a method; returning an empty
      // dashboard would repeat the defect that made coach-page bookings
      // invisible. `.in('col', [])` is not a query worth sending, so the read is
      // skipped and the array is empty instead.
      funnelIds.length
        ? supabase.from('funnel_leads').select(LEAD_COLUMNS).in('funnel_id', funnelIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      // BOTH OWNERSHIP ARMS, active only — one scan serving every booking-derived
      // number below instead of three endpoints scanning it separately.
      loadOwnedActiveBookings<DashBooking>({ userId, funnelIds, columns: BOOKING_COLUMNS }),
      supabase.from('client_programs').select(PROGRAM_COLUMNS).eq('user_id', userId),
      supabase.from('funnel_business_settings').select('booking_slug').eq('user_id', userId).maybeSingle(),
      supabase.from('saved_outputs').select('content').eq('user_id', userId).eq('tool_type', 'framework').maybeSingle(),
      supabase.from('saved_outputs').select('content').eq('user_id', userId).eq('tool_type', 'core_offers').maybeSingle(),
      // Blueprints are validated problem_solution_cards, NOT a saved_output —
      // lib/syncDependencies.ts is the authority on that and reading it is why
      // this is a head-count on the right table rather than a guess at a
      // tool_type that does not exist.
      supabase.from('problem_solution_cards').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('validated', true),
    ])
    if ((leadsRes as any).error) throw (leadsRes as any).error
    if (programsRes.error) throw programsRes.error

    type DashLead = {
      id: string
      funnel_id: string
      email: string
      name: string | null
      first_name: string | null
      status: string | null
      application_status: string | null
      application_submitted_at: string | null
      created_at: string
    }
    const leads = ((leadsRes as any).data || []) as DashLead[]
    const programs = (programsRes.data || []) as unknown as ProgramRow[]
    const programIds = programs.map((p) => p.id)

    const [itemsRes, requestsRes, notesRes, programBookingsRes] = await Promise.all([
      programIds.length
        ? supabase.from('client_program_items').select(ITEM_COLUMNS).in('program_id', programIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      programIds.length
        ? supabase
            .from('client_program_session_requests')
            .select('id, program_id, item_id, note, preferred_1, preferred_2, status, created_at')
            .in('program_id', programIds)
            .eq('status', 'requested')
        : Promise.resolve({ data: [] as any[], error: null }),
      // The only signal that a human has touched a lead. funnel_lead_notes holds
      // zero rows today; it is read anyway because the moment one exists that
      // lead is no longer "no activity".
      leads.length
        ? supabase.from('funnel_lead_notes').select('lead_id').in('lead_id', leads.map((l) => l.id as string))
        : Promise.resolve({ data: [] as any[], error: null }),
      // THE ALLOWANCE IS COUNTED BY program_id, AND NOT status='active'.
      //
      // A different question from coach ownership, so deliberately not the
      // loadOwnedActiveBookings set: that filters status='active', and a call
      // cancelled too late still CONSUMES a session. Counting only active
      // bookings would over-report what a client has left — the same error as
      // sessions_used in reverse, and it hands back a call the client already
      // had. sessionsUsed owns that rule; this only feeds it the rows.
      programIds.length
        ? supabase.from('bookings').select('id, program_id, status, start_time, canceled_at').in('program_id', programIds)
        : Promise.resolve({ data: [] as any[], error: null }),
    ])
    if ((itemsRes as any).error) throw (itemsRes as any).error
    if ((requestsRes as any).error) throw (requestsRes as any).error

    const items = ((itemsRes as any).data || []) as (ItemRow & { program_id: string })[]
    const openRequests = ((requestsRes as any).data || []) as Record<string, any>[]
    const leadIdsWithNotes = new Set<string>(((notesRes as any).data || []).map((n: any) => String(n.lead_id)))

    const programBookings = ((programBookingsRes as any).data || []) as (ProgramBookingRow & { program_id: string })[]
    const usedByProgram = new Map<string, number>()
    for (const p of programs) {
      usedByProgram.set(p.id, sessionsUsed(programBookings.filter((b) => b.program_id === p.id)))
    }

    const itemsByProgram = new Map<string, ItemRow[]>()
    for (const i of items) {
      const list = itemsByProgram.get(i.program_id)
      if (list) list.push(i)
      else itemsByProgram.set(i.program_id, [i])
    }
    const requestsByProgram = new Map<string, number>()
    for (const r of openRequests) {
      requestsByProgram.set(String(r.program_id), (requestsByProgram.get(String(r.program_id)) ?? 0) + 1)
    }

    // ---- work queues, from the shared predicates ---------------------------
    const resolveLead = buildLeadResolver<DashLead, DashBooking>(leads)
    const needsOutcomeRows = needsOutcome(bookings, resolveLead, now)
    const approvedNotBookedRows = approvedNotBooked(leads, bookings, userId)

    // Any booking clears a lead from "no activity", by address — including a
    // coach-page one, which has no funnel to key on.
    const bookedEmails = new Set(bookings.map((b) => String(b.email || '').trim().toLowerCase()).filter(Boolean))
    const noActivityRows = noActivity(leads, { bookedEmails, leadIdsWithNotes })

    // ---- funnels ------------------------------------------------------------
    // FUNNEL-SCOPED, both halves. Leads whose funnel_id is this funnel over
    // bookings whose funnel_id is this funnel. A coach-page call belongs to no
    // funnel and is deliberately in neither.
    const leadsPerFunnel = new Map<string, number>()
    for (const l of leads) leadsPerFunnel.set(String(l.funnel_id), (leadsPerFunnel.get(String(l.funnel_id)) ?? 0) + 1)
    const bookedPerFunnel = new Map<string, number>()
    for (const b of bookings) {
      if (!b.funnel_id) continue
      bookedPerFunnel.set(String(b.funnel_id), (bookedPerFunnel.get(String(b.funnel_id)) ?? 0) + 1)
    }
    const funnelList = funnels
      .map((f) => {
        const leadCount = leadsPerFunnel.get(String(f.id)) ?? 0
        const booked = bookedPerFunnel.get(String(f.id)) ?? 0
        return {
          id: f.id as string,
          name: funnelDisplayName(f),
          status: (f.status as string) ?? null,
          leads: leadCount,
          booked,
          book_rate: bookRate({ leads: leadCount, booked }),
        }
      })
      // Live before draft, then leads descending. A coach has 1–10 funnels, so
      // this list is not truncated — truncating it would be theatre.
      .sort((a, b) => Number(b.status === 'live') - Number(a.status === 'live') || b.leads - a.leads)

    // ---- calls --------------------------------------------------------------
    const upcoming = bookings.filter((b) => b.start_time && String(b.start_time) >= nowIso)
    const thisWeek = upcoming.filter((b) => Date.parse(String(b.start_time)) < now + WEEK_MS)
    const reconciliation = callsReconciliation(bookings)

    // ---- clients ------------------------------------------------------------
    const clientInputs = programs.map((p) => ({
      program: p,
      items: itemsByProgram.get(p.id) ?? [],
      openRequests: requestsByProgram.get(p.id) ?? 0,
    }))
    const stalledCount = clientInputs.filter((c) => c.program.status === 'active' && isStalled(c.items, today)).length
    const draftCount = programs.filter((p) => p.status === 'draft').length

    // ---- the attention strip ------------------------------------------------
    // COUNTS OVER EVERYTHING, computed here from the full sets before any list
    // below is sliced.
    const counts: Record<AttentionKey, number> = {
      open_session_requests: openRequests.length,
      stalled_clients: stalledCount,
      calls_needing_outcome: needsOutcomeRows.length,
      approved_not_booked: approvedNotBookedRows.length,
      leads_no_activity: noActivityRows.length,
      programme_drafts: draftCount,
      calls_this_week: thisWeek.length,
      funnels_in_draft: funnels.filter((f) => f.status !== 'live').length,
    }
    const details: Partial<Record<AttentionKey, string | null>> = {
      // Oldest first out of the predicate, so [0] is the most overdue.
      calls_needing_outcome: relativeDay(String(needsOutcomeRows[0]?.start_time ?? '') || null, now),
      approved_not_booked: relativeDay(String(approvedNotBookedRows[0]?.application_submitted_at ?? '') || null, now),
      leads_no_activity: relativeDay(noActivityRows[0]?.created_at ?? null, now),
      calls_this_week: relativeDay(String(thisWeek[0]?.start_time ?? '') || null, now),
      open_session_requests: relativeDay(String(openRequests[0]?.created_at ?? '') || null, now),
    }

    return res.status(200).json({
      attention: attentionStrip(counts, details),
      counts,
      clients: {
        total: programs.length,
        active: programs.filter((p) => p.status === 'active').length,
        stalled: stalledCount,
        drafts: draftCount,
        list: serializeClients(clientInputs, today),
      },
      funnels: {
        total: funnels.length,
        live: funnels.filter((f) => f.status === 'live').length,
        list: funnelList,
      },
      calls: {
        // Three numbers that must add up — see callsReconciliation for the
        // window and why the funnel column sums to less than the total.
        ...reconciliation,
        this_week: thisWeek.length,
        needs_outcome: needsOutcomeRows.length,
        upcoming: upcoming.slice(0, UPCOMING_LIMIT).map((b) => ({
          booking_id: b.id,
          name: b.name || b.email,
          start_time: b.start_time as string,
          end_time: b.end_time ?? null,
          funnel_id: b.funnel_id ?? null,
          funnel_name: b.funnel_id ? funnelDisplayName(funnels.find((f) => f.id === b.funnel_id)) : null,
        })),
      },
      leads: {
        total: leads.length,
        no_activity: noActivityRows.length,
        approved_not_booked: approvedNotBookedRows.length,
        // Oldest first: age is the reason they are listed.
        list: noActivityRows.slice(0, LEAD_LIST_LIMIT).map((l) => ({
          lead_id: l.id as string,
          name: (l.name as string) || (l.first_name as string) || (l.email as string),
          email: l.email as string,
          funnel_id: l.funnel_id as string,
          funnel_name: funnelDisplayName(funnels.find((f) => f.id === l.funnel_id)),
          created_at: l.created_at as string,
        })),
      },
      session_requests: openRequests
        .slice()
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, REQUEST_LIST_LIMIT)
        .map((r) => {
          const program = programs.find((p) => p.id === r.program_id)
          const used = usedByProgram.get(String(r.program_id)) ?? 0
          return {
            id: r.id as string,
            program_id: r.program_id as string,
            client_name: program?.client_name ?? null,
            note: (r.note as string) ?? null,
            preferred_1: (r.preferred_1 as string) ?? null,
            preferred_2: (r.preferred_2 as string) ?? null,
            sessions_allowed: program?.sessions_allowed ?? null,
            sessions_remaining: program ? Math.max(0, program.sessions_allowed - used) : null,
            created_at: r.created_at as string,
          }
        }),
      method: serializeMethod(
        ((frameworkRes as any)?.data?.content as Record<string, unknown>) ?? null,
        ((offersRes as any)?.data?.content as Record<string, unknown>) ?? null,
        (blueprintsRes as any)?.count ?? 0,
        (settingsRes as any)?.data?.booking_slug
          ? `${process.env.APP_URL || 'https://app.microtrainingmethod.com'}/book/${(settingsRes as any).data.booking_slug}`
          : null
      ),
    })
  } catch (err) {
    console.error('[dashboard/my-business]', err)
    return res.status(500).json({ error: 'Failed to load dashboard' })
  }
}
