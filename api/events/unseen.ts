import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors, noStore } from '../../lib/cors'

// GET /api/events/unseen — { has_new } for the Office Hours nav badge.
//
// True when any event was created after the caller last opened the calendar.
// Two cheap reads, no join: the newest created_at in the whole table (the
// badge does not care WHICH event is new, only that one is) and this user's
// own last_viewed_at.
//
// Keyed on events.created_at, not starts_at — so an admin editing an
// existing event's date or time does not re-badge everyone who already saw
// it. Only a genuinely new row, which is the only thing that produces a new
// created_at, does.
//
// A member who has never opened the page has no row at all, which is treated
// as "never viewed" — so has_new is true whenever any event exists. A brand
// new member is therefore badged on their first login: there IS something
// there they have not seen.
//
// Gated on office_hours like the rest of the surface: no capability, no
// badge, since the nav item should not tease content the member cannot open.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (!(await requireCapability(userId, 'office_hours', res))) return

  try {
    const [newestRes, viewRes] = await Promise.all([
      supabase.from('events').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('event_calendar_views').select('last_viewed_at').eq('user_id', userId).maybeSingle(),
    ])
    if (newestRes.error) throw newestRes.error
    if (viewRes.error) throw viewRes.error

    const newestCreatedAt = (newestRes.data as any)?.created_at as string | undefined
    // No events at all: nothing to have missed, regardless of view history.
    if (!newestCreatedAt) return res.status(200).json({ has_new: false })

    const lastViewedAt = (viewRes.data as any)?.last_viewed_at as string | undefined
    if (!lastViewedAt) return res.status(200).json({ has_new: true })

    return res.status(200).json({ has_new: new Date(newestCreatedAt).getTime() > new Date(lastViewedAt).getTime() })
  } catch (err) {
    console.error('[events/unseen] GET', err)
    // Fail closed: a badge shown because of a transient database error is a
    // nag the member cannot clear by looking, since the underlying read is
    // what is broken. Missing one is the cheaper failure.
    return res.status(200).json({ has_new: false })
  }
}
