import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireAdmin } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { createMember } from '../../../lib/memberInvite'

// GET  — list members (admin).
// POST — create one member and, by default, invite them (admin).
//
// POST is the ONLY way a user row is created from a request in this codebase
// (api/members/invite-beta.ts is a GHL webhook gated on WEBHOOK_SECRET, not a
// request anyone can make). There is no sign-up endpoint and none is to be
// added: api/auth/send-magic-link.ts stays lookup-only, and that is the guard
// enforcing the product decision.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end()

  const userId = await requireAdmin(req, res)
  if (!userId) return

  if (req.method === 'POST') return createHandler(req, res)

  const rawTier = req.query.tier
  const rawStatus = req.query.status
  const tier = Array.isArray(rawTier) ? rawTier[0] : rawTier
  const status = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus

  try {
    let query = supabase
      .from('users')
      .select('id, name, email, membership_tier, status, created_at')
      .order('created_at', { ascending: false })

    if (tier) query = query.eq('membership_tier', tier)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error

    return res.status(200).json({ members: data || [] })
  } catch (err) {
    console.error('[admin/members] GET', err)
    return res.status(500).json({ error: 'Failed to load members' })
  }
}

async function createHandler(req: VercelRequest, res: VercelResponse) {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  try {
    const result = await createMember({
      name: body.name,
      email: body.email,
      membership_tier: body.membership_tier,
      add_ons: body.add_ons,
      send_invite: body.send_invite,
    })

    if (result.outcome === 'rejected') {
      const status = result.reason === 'write_failed' ? 500 : 400
      return res.status(status).json({ error: result.reason, message: result.message, email: result.email })
    }

    // 409 with the EXISTING member named, rather than a duplicate row or a
    // silent tier change. A workshop CSV re-importing a paying member must not
    // quietly move them onto the workshop tier.
    if (result.outcome === 'skipped_existing') {
      return res.status(409).json({
        error: 'member_exists',
        message: `A member with ${result.existing.email} already exists (${result.existing.membership_tier}). Nothing was changed.`,
        existing: result.existing,
      })
    }

    // `invite` always states what happened — sent, or not sent and why. A
    // `free` member is created and told plainly that no invite went out,
    // because free has no app_login capability.
    return res.status(201).json({ member: result.member, invite: result.invite })
  } catch (err) {
    console.error('[admin/members] POST', err)
    return res.status(500).json({ error: 'Failed to create member' })
  }
}
