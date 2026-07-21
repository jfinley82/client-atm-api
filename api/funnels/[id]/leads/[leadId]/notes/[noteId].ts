import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../../lib/supabase'
import { setCors } from '../../../../../../lib/cors'
import { requireFunnelBuilder, getOwnedLead } from '../../../../../../lib/funnels'

// DELETE /api/funnels/[id]/leads/[leadId]/notes/[noteId] — remove a note from the
// lead's thread. Owner-scoped: the funnel must be the caller's and the note must
// belong to this funnel + lead.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'DELETE') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  const leadId = req.query.leadId as string
  const noteId = req.query.noteId as string
  if (!id || !leadId || !noteId) return res.status(400).json({ error: 'id, leadId and noteId required' })

  const lead = await getOwnedLead(userId, id, leadId)
  if (!lead) return res.status(404).json({ error: 'Lead not found' })

  try {
    const { data, error } = await supabase
      .from('funnel_lead_notes')
      .delete()
      .eq('id', noteId)
      .eq('funnel_id', id)
      .eq('lead_id', leadId)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Note not found' })
    return res.status(200).json({ deleted: true })
  } catch (err) {
    console.error('[funnels/leads/notes/[noteId]] DELETE', err)
    return res.status(500).json({ error: 'Failed to delete note' })
  }
}
