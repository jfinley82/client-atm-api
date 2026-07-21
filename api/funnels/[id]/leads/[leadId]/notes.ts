import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { setCors, noStore } from '../../../../../lib/cors'
import { requireFunnelBuilder, getOwnedLead } from '../../../../../lib/funnels'

// GET/POST /api/funnels/[id]/leads/[leadId]/notes — the lead's timestamped,
// author-attributed notes thread (owner-scoped).
//   GET  → { notes } newest first, each with author_name.
//   POST { body } → create a note authored by the authenticated user.

// Attach a display name to each note from its author_user_id, resolved in one
// batch query (avoids PostgREST embed ambiguity).
async function withAuthors(rows: Array<Record<string, any>>): Promise<Array<Record<string, any>>> {
  const ids = [...new Set(rows.map((r) => r.author_user_id).filter((x): x is string => !!x))]
  const names = new Map<string, string>()
  if (ids.length) {
    const { data } = await supabase.from('users').select('id, name, email').in('id', ids)
    for (const u of data || []) {
      const nm = typeof u.name === 'string' && u.name.trim() ? u.name.trim() : (u.email as string) || 'Unknown'
      names.set(u.id as string, nm)
    }
  }
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    created_at: r.created_at,
    author_user_id: r.author_user_id,
    author_name: r.author_user_id ? names.get(r.author_user_id) ?? 'Unknown' : 'Unknown',
  }))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  const leadId = req.query.leadId as string
  if (!id || !leadId) return res.status(400).json({ error: 'id and leadId required' })

  // Ownership: the funnel must be the caller's AND the lead must belong to it.
  const lead = await getOwnedLead(userId, id, leadId)
  if (!lead) return res.status(404).json({ error: 'Lead not found' })

  if (req.method === 'GET') {
    noStore(res)
    try {
      const { data, error } = await supabase
        .from('funnel_lead_notes')
        .select('id, body, created_at, author_user_id')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return res.status(200).json({ notes: await withAuthors(data || []) })
    } catch (err) {
      console.error('[funnels/leads/notes] GET', err)
      return res.status(500).json({ error: 'Failed to load notes' })
    }
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!text) return res.status(400).json({ error: 'body is required (non-empty string)' })
    if (text.length > 10000) return res.status(400).json({ error: 'body too long' })

    try {
      const { data, error } = await supabase
        .from('funnel_lead_notes')
        .insert({ funnel_id: id, lead_id: leadId, author_user_id: userId, body: text })
        .select('id, body, created_at, author_user_id')
        .single()
      if (error) throw error
      const [note] = await withAuthors([data])
      return res.status(200).json({ note })
    } catch (err) {
      console.error('[funnels/leads/notes] POST', err)
      return res.status(500).json({ error: 'Failed to add note' })
    }
  }

  return res.status(405).end()
}
