import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { planFromSnapshot, resolveSessionsAllowed, isValidStartDate } from '../../lib/clientProgramPlan'
import { serializeProgramSummary, type ItemRow, type ProgramRow, type ProgramBookingRow } from '../../lib/clientProgramSerializers'

// GET  /api/client-programs — the coach's programs.
// POST /api/client-programs — create one, as a DRAFT. Sends nothing.
//
// A draft is the whole point of this endpoint returning 201 without mailing
// anyone: the coach reviews the generated plan, resequences it and adds tasks
// before the client can see any of it. POST .../[id]/send is the only path to
// `active`, and there is no path back.
export const config = { maxDuration: 30 }

const PROGRAM_COLUMNS =
  'id, user_id, lead_id, client_name, client_email, client_timezone, program_name, total_weeks, sessions_allowed, start_date, status, portal_token_version, portal_last_opened_at, activated_at, completed_at'
const ITEM_COLUMNS =
  'id, program_id, kind, sequence_position, source_week, sort_order, title, detail, phase_name, due_date, due_date_source, status, completed_at, completed_by'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  if (req.method === 'POST') return createProgram(req, res, userId)
  return listPrograms(res, userId)
}

// Today in UTC. The client's own zone can shift this by a day, which matters for
// current_week; the list is the coach's view and the coach's programs span many
// zones, so one consistent basis beats N answers that disagree by a day.
const todayUtc = () => new Date().toISOString().slice(0, 10)

async function listPrograms(res: VercelResponse, userId: string) {
  try {
    const { data: programs, error } = await supabase
      .from('client_programs')
      .select(PROGRAM_COLUMNS)
      .eq('user_id', userId)
      .order('start_date', { ascending: false })
    if (error) throw error

    const rows = (programs || []) as ProgramRow[]
    if (!rows.length) return res.status(200).json({ programs: [], due_this_week: 0 })

    const ids = rows.map((p) => p.id)
    const [itemsRes, bookingsRes, requestsRes] = await Promise.all([
      supabase.from('client_program_items').select(ITEM_COLUMNS).in('program_id', ids),
      supabase.from('bookings').select('id, program_id, status, start_time, canceled_at').in('program_id', ids),
      supabase.from('client_program_session_requests').select('id, program_id, status').in('program_id', ids).eq('status', 'requested'),
    ])
    if (itemsRes.error) throw itemsRes.error
    if (bookingsRes.error) throw bookingsRes.error
    if (requestsRes.error) throw requestsRes.error

    const itemsBy = groupBy((itemsRes.data || []) as (ItemRow & { program_id: string })[], (r) => r.program_id)
    const bookingsBy = groupBy((bookingsRes.data || []) as (ProgramBookingRow & { program_id: string })[], (r) => r.program_id)
    const openBy = groupBy((requestsRes.data || []) as { program_id: string }[], (r) => r.program_id)

    const today = todayUtc()
    const programsOut = rows.map((program) =>
      serializeProgramSummary({
        program,
        items: itemsBy.get(program.id) || [],
        bookings: bookingsBy.get(program.id) || [],
        openSessionRequests: (openBy.get(program.id) || []).length,
        today,
      })
    )

    return res.status(200).json({ programs: programsOut, due_this_week: dueThisWeek(rows, itemsBy, today) })
  } catch (err) {
    console.error('[client-programs] GET', err)
    return res.status(500).json({ error: 'Failed to load programs' })
  }
}

/**
 * "Due this week" across every ACTIVE program.
 *
 * A LIST-LEVEL AGGREGATE, not a fold over next_item. Each program contributes
 * one next_item, so counting those would report at most one per program and
 * undercount any client with three things due — the number would look plausible
 * and be wrong, which is the worst kind.
 */
function dueThisWeek(programs: ProgramRow[], itemsBy: Map<string, ItemRow[]>, today: string): number {
  const start = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(start)) return 0
  const end = new Date(start + 7 * 86_400_000).toISOString().slice(0, 10)
  let count = 0
  for (const p of programs) {
    if (p.status !== 'active') continue
    for (const i of itemsBy.get(p.id) || []) {
      if (i.kind === 'week' || i.status !== 'pending' || !i.due_date) continue
      if (i.due_date >= today && i.due_date < end) count++
    }
  }
  return count
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}

async function createProgram(req: VercelRequest, res: VercelResponse, userId: string) {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  const leadId = typeof body.lead_id === 'string' && body.lead_id.trim() ? body.lead_id.trim() : null
  const bodyName = typeof body.client_name === 'string' ? body.client_name.trim() : ''
  const bodyEmail = typeof body.client_email === 'string' ? body.client_email.trim() : ''

  if (!isValidStartDate(body.start_date)) return res.status(400).json({ error: 'invalid_start_date' })
  const startDate = body.start_date as string

  // lead_id OR (name + email). A lead carries both, so requiring them alongside
  // it would make the caller repeat what we can read.
  if (!leadId && !(bodyName && bodyEmail)) {
    return res.status(400).json({ error: 'invalid_field', field: 'lead_id', message: 'lead_id, or client_name and client_email' })
  }

  try {
    let clientName = bodyName
    let clientEmail = bodyEmail

    if (leadId) {
      const { data: lead } = await supabase
        .from('funnel_leads')
        .select('id, funnel_id, email, name, first_name')
        .eq('id', leadId)
        .maybeSingle()
      if (!lead) return res.status(403).json({ error: 'forbidden' })

      // OWNERSHIP THROUGH THE LEAD'S FUNNEL, never from the body. A lead id is a
      // caller-supplied value, and trusting it is the same class of mistake as
      // authorizing from a body id.
      const leadFunnelId = (lead as any).funnel_id as string | null
      if (!leadFunnelId) return res.status(400).json({ error: 'lead_has_no_funnel' })
      const { data: funnel } = await supabase.from('funnels').select('id, user_id').eq('id', leadFunnelId).maybeSingle()
      if (!funnel || (funnel as any).user_id !== userId) return res.status(403).json({ error: 'forbidden' })

      clientName = bodyName || pickName(lead as Record<string, unknown>, String((lead as any).email || ''))
      clientEmail = bodyEmail || String((lead as any).email || '')
    }

    if (!clientEmail) {
      return res.status(400).json({ error: 'invalid_field', field: 'client_email', message: 'client_email is required' })
    }

    // The coach's own confirmed program. saved_outputs is UNIQUE(user_id, tool_type),
    // so there is exactly one row to snapshot.
    const { data: saved } = await supabase
      .from('saved_outputs')
      .select('content')
      .eq('user_id', userId)
      .eq('tool_type', 'program')
      .maybeSingle()

    const snapshot = (saved as { content?: unknown } | null)?.content ?? null
    const plan = planFromSnapshot(snapshot, startDate)
    if (!plan.ok) {
      const status = plan.reason === 'program_too_long' ? 422 : 400
      return res.status(status).json(plan.reason === 'program_too_long' ? { error: plan.reason, total_weeks: plan.total_weeks } : { error: plan.reason })
    }

    const sessions = resolveSessionsAllowed(body.sessions_allowed, snapshot)
    if (!sessions.ok) return res.status(400).json({ error: sessions.reason })

    const { data: created, error: insertErr } = await supabase
      .from('client_programs')
      .insert({
        user_id: userId,
        lead_id: leadId,
        client_name: clientName,
        client_email: clientEmail,
        client_timezone: typeof body.client_timezone === 'string' && body.client_timezone.trim() ? body.client_timezone.trim() : null,
        // SNAPSHOT, not a reference. saved_outputs holds one program row per
        // coach, so reading it live would let one edit rewrite the plan of every
        // client already running on the old one, mid-flight.
        program_snapshot: snapshot,
        program_name: plan.program_name,
        total_weeks: plan.total_weeks,
        sessions_allowed: sessions.value,
        start_date: startDate,
        status: 'draft',
      })
      .select(PROGRAM_COLUMNS)
      .single()

    if (insertErr) {
      // uq_client_programs_lead does not filter on status, so a draft already
      // holds this lead. Named rather than 500'd, because the coach can act on
      // it — and DELETE on a draft is how they take it back.
      if ((insertErr as { code?: string }).code === '23505') return res.status(409).json({ error: 'program_exists' })
      throw insertErr
    }

    const program = created as unknown as ProgramRow

    const { error: itemsErr } = await supabase
      .from('client_program_items')
      .insert(plan.items.map((i) => ({ ...i, program_id: program.id })))

    if (itemsErr) {
      // A PROGRAM WITH NO ITEMS IS WORSE THAN NO PROGRAM: it holds the lead
      // through uq_client_programs_lead while being unusable, and the coach
      // cannot create the real one. There is no transaction across two PostgREST
      // calls, so the rollback is explicit.
      console.error('[client-programs] items insert failed — removing the program row', itemsErr)
      await supabase.from('client_programs').delete().eq('id', program.id)
      return res.status(500).json({ error: 'Failed to create program' })
    }

    const items = plan.items.map((i, n) => ({ ...i, id: `${program.id}:${n}`, completed_at: null, completed_by: null })) as unknown as ItemRow[]
    return res.status(201).json({
      program: serializeProgramSummary({ program, items, bookings: [], openSessionRequests: 0, today: todayUtc() }),
    })
  } catch (err) {
    console.error('[client-programs] POST', err)
    return res.status(500).json({ error: 'Failed to create program' })
  }
}

// Lead name first (what the coach knows them as), then the address's local part.
// Never empty — an unnamed client renders as a blank row the coach cannot read.
function pickName(lead: Record<string, unknown>, email: string): string {
  for (const v of [lead.name, lead.first_name]) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return email.split('@')[0] || email
}
