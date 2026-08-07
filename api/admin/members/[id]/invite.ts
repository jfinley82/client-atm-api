import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { requireAdmin } from '../../../../lib/auth'
import { setCors } from '../../../../lib/cors'
import { sendMemberInvite } from '../../../../lib/memberInvite'

// POST /api/admin/members/[id]/invite — mint and mail a fresh invite.
//
// For the member who never got the first one, or whose seven days ran out. The
// member's own route out of an expired invite is the resend prompt on the
// callback error page (api/auth/callback.ts -> ?error=invite_expired), which
// goes through send-magic-link and needs no admin at all. This endpoint is for
// the cases that never reach a page: a wrong address corrected in the member
// row, or a send that failed at Resend.
//
// Old invites are NOT revoked. Each is single-use and expires on its own; a
// member holding two live links simply uses whichever arrives first, and
// invalidating the earlier one would break the case where the resend is the
// copy that bounced.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    const { data: member, error } = await supabase
      .from('users')
      .select('id, email, name, membership_tier, status, role')
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    if (!member) return res.status(404).json({ error: 'Member not found' })

    // A suspended account must never be handed a session, and the redemption
    // path would refuse it anyway (api/auth/callback.ts). Refusing here means
    // the admin is told, rather than the member receiving a link that dies on
    // click.
    if ((member as { status?: string }).status === 'suspended') {
      return res.status(409).json({
        error: 'account_suspended',
        message: 'This member is suspended. Reactivate them before sending an invite.',
      })
    }

    const invite = await sendMemberInvite({
      id: (member as { id: string }).id,
      email: (member as { email: string }).email,
      name: ((member as { name?: string | null }).name) ?? null,
      membership_tier: (member as { membership_tier: string }).membership_tier,
      role: ((member as { role?: string | null }).role) ?? 'user',
    })

    // 200 either way: "no invite sent, and here is why" is a successful answer
    // to "what happened", not a failed request. The caller reads `invite.sent`.
    return res.status(200).json({ member_id: id, invite })
  } catch (err) {
    console.error('[admin/members/[id]/invite] POST', err)
    return res.status(500).json({ error: 'Failed to send invite' })
  }
}
