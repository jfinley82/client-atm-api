import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireAdmin } from '../../../lib/auth'
import { CLOSED_STAGES, isTicketPriority, isTicketStage, slaFor, TICKET_PRIORITIES, TICKET_STAGES } from '../../../lib/support'

// GET /api/admin/support/tickets — the triage list behind both the Kanban and
// List views. Admin-only, matching the whole /api/admin/* namespace.
//
// Query: stage, priority, search (subject + member name/email), limit.
//
// `search` spans the member as well as the subject, so it has to match across a
// join. PostgREST cannot OR across an embedded relation, so the member half is
// resolved to ids first and folded into the filter — see below.
export const config = { maxDuration: 30 }

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

const TICKET_COLUMNS =
  'id, user_id, category, subject, stage, priority, funnel_id, assigned_admin_id, first_response_at, resolved_at, created_at, updated_at'

function strParam(v: unknown): string {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s.trim() : ''
}

// PostgREST `or=` is comma-separated, so a comma in user input would be read as
// another condition. Parens and backslashes end the value early the same way.
function escapeForOr(s: string): string {
  return s.replace(/[,()\\]/g, ' ')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  const stage = strParam(req.query.stage)
  const priority = strParam(req.query.priority)
  const search = strParam(req.query.search)
  const limitRaw = Number(strParam(req.query.limit))
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= MAX_LIMIT ? limitRaw : DEFAULT_LIMIT

  if (stage && stage !== 'all' && !isTicketStage(stage)) {
    return res.status(400).json({ error: 'invalid_field', field: 'stage', allowed: ['all', ...TICKET_STAGES] })
  }
  if (priority && priority !== 'all' && !isTicketPriority(priority)) {
    return res.status(400).json({ error: 'invalid_field', field: 'priority', allowed: ['all', ...TICKET_PRIORITIES] })
  }

  try {
    let query = supabase.from('support_tickets').select(TICKET_COLUMNS).order('created_at', { ascending: false }).limit(limit)
    if (stage && stage !== 'all') query = query.eq('stage', stage)
    if (priority && priority !== 'all') query = query.eq('priority', priority)

    if (search) {
      const safe = escapeForOr(search)
      // Members whose name or email matches, so a search for a person returns
      // their tickets even when the subject says nothing about them.
      const { data: matchedUsers } = await supabase
        .from('users')
        .select('id')
        .or(`name.ilike.%${safe}%,email.ilike.%${safe}%`)
        .limit(MAX_LIMIT)
      const userIds = (matchedUsers || []).map((u: any) => u.id).filter(Boolean)

      query = userIds.length
        ? query.or(`subject.ilike.%${safe}%,user_id.in.(${userIds.join(',')})`)
        : query.ilike('subject', `%${safe}%`)
    }

    const { data, error } = await query
    if (error) throw error
    const tickets = (data || []) as any[]

    // One lookup for every member and assignee on the page — the list shows a
    // name per card, and N+1 per-row fetches for that would be gratuitous.
    const ids = [...new Set(tickets.flatMap((t) => [t.user_id, t.assigned_admin_id]).filter(Boolean))] as string[]
    const byId = new Map<string, { name: string | null; email: string | null }>()
    if (ids.length) {
      const { data: users } = await supabase.from('users').select('id, name, email').in('id', ids)
      for (const u of (users || []) as any[]) byId.set(u.id, { name: u.name ?? null, email: u.email ?? null })
    }

    const now = Date.now()
    return res.status(200).json({
      tickets: tickets.map((t) => ({
        ...t,
        member: byId.get(t.user_id) ?? null,
        assigned_admin: t.assigned_admin_id ? byId.get(t.assigned_admin_id) ?? null : null,
        // Precomputed so the card's age indicator turns red on the SAME rule the
        // breach tile counts, rather than on how large the number looks.
        sla: slaFor(t, now),
      })),
      // Column counts for the Kanban badges, over the SAME filtered set the
      // cards come from, so a badge can't claim more than the column shows.
      stage_counts: TICKET_STAGES.reduce(
        (acc, s) => ({ ...acc, [s]: tickets.filter((t) => t.stage === s).length }),
        {} as Record<string, number>
      ),
      open_count: tickets.filter((t) => !(CLOSED_STAGES as readonly string[]).includes(t.stage)).length,
    })
  } catch (err) {
    console.error('[admin/support/tickets] GET', err)
    return res.status(500).json({ error: 'Failed to load tickets' })
  }
}
