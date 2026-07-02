import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getMtmSessionProgress } from '../../../lib/progress'

const VALID_TIERS = ['free', 'low_ticket', 'full']
const VALID_STATUSES = ['active', 'suspended']

// Safe user columns to expose to admins (never password_hash)
const MEMBER_COLUMNS =
  'id, email, name, profession, has_paid, quiz_completed, quiz_score, video_watched, membership_tier, status, role, created_at'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const { data: actingUser } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (!actingUser || actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    try {
      const { data: member, error } = await supabase
        .from('users')
        .select(MEMBER_COLUMNS)
        .eq('id', id)
        .maybeSingle()

      if (error) throw error
      if (!member) return res.status(404).json({ error: 'Member not found' })

      // MTM blueprint session progress, matching what the member sees on their
      // own dashboard (Audience, Transformation, Matcher, Blueprint generation).
      const session_progress = await getMtmSessionProgress(id)

      return res.status(200).json({ member, session_progress })
    } catch (err) {
      console.error('[admin/members/[id]] GET', err)
      return res.status(500).json({ error: 'Failed to load member' })
    }
  }

  if (req.method === 'PATCH') {
    const { membership_tier, status } = req.body || {}
    const updates: Record<string, unknown> = {}

    if (membership_tier !== undefined) {
      if (!VALID_TIERS.includes(membership_tier)) {
        return res.status(400).json({ error: "membership_tier must be 'free', 'low_ticket', or 'full'" })
      }
      updates.membership_tier = membership_tier
    }

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: "status must be 'active' or 'suspended'" })
      }
      updates.status = status
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Provide membership_tier and/or status' })
    }

    try {
      const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', id)
        .select(MEMBER_COLUMNS)
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Member not found' })

      return res.status(200).json({ member: data })
    } catch (err) {
      console.error('[admin/members/[id]] PATCH', err)
      return res.status(500).json({ error: 'Failed to update member' })
    }
  }

  return res.status(405).end()
}
