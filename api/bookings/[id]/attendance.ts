import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder } from '../../../lib/funnels'
import { schedulePostCallEmails, cancelPostCallEmails } from '../../../lib/funnelNurture'

// POST /api/bookings/[id]/attendance — the coach marks whether the lead turned up.
// Body: { attended: 'showed' | 'no_show' }
//
// Marking 'showed' schedules the funnel's 3 post-call follow-up emails. Marking
// 'no_show' never sends anything, and CANCELS the sequence if it was already
// scheduled by an earlier mistaken 'showed' — a "great speaking with you" email
// to someone who never joined is worse than no follow-up at all.
//
// Idempotent: re-posting the same value is a no-op, so a double-click cannot
// schedule the sequence twice. Only a transition INTO 'showed' schedules.
export const config = { maxDuration: 60 }

const VALUES = ['showed', 'no_show']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const attended = typeof body.attended === 'string' ? body.attended.trim() : ''
  if (!VALUES.includes(attended)) {
    return res.status(400).json({ error: 'invalid_field', field: 'attended', message: `Must be one of: ${VALUES.join(', ')}.` })
  }

  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('id, coach_user_id, funnel_id, email, attended, start_time, status')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!booking) return res.status(404).json({ error: 'Booking not found' })

    // Ownership, two ways. The Google path stamps coach_user_id; the shared-Zoom
    // path deliberately leaves it NULL (one shared host) and carries funnel_id
    // instead, so a legacy booking is owned by whoever owns its funnel. Checking
    // only coach_user_id would lock every native-calendar coach out of their own
    // calls.
    if (!(await ownsBooking(userId, booking))) return res.status(404).json({ error: 'Booking not found' })

    const previous = typeof booking.attended === 'string' ? booking.attended : null
    if (previous === attended) {
      return res.status(200).json({ ok: true, attended, unchanged: true })
    }

    const { error: updErr } = await supabase
      .from('bookings')
      .update({ attended, attendance_marked_at: new Date().toISOString() })
      .eq('id', id)
    if (updErr) throw updErr

    let scheduled = false
    if (attended === 'showed') {
      scheduled = await runPostCall(booking)
    } else {
      // Corrected to no_show — pull back anything a previous 'showed' queued.
      await cancelPostCallEmails(id)
    }

    return res.status(200).json({ ok: true, attended, post_call_scheduled: scheduled })
  } catch (err) {
    console.error('[bookings/[id]/attendance] POST', err)
    return res.status(500).json({ error: 'Failed to mark attendance' })
  }
}

// ---- helpers ----------------------------------------------------------------

async function ownsBooking(userId: string, booking: Record<string, any>): Promise<boolean> {
  if (booking.coach_user_id) return booking.coach_user_id === userId
  if (!booking.funnel_id) return false
  const { data } = await supabase.from('funnels').select('id').eq('id', booking.funnel_id).eq('user_id', userId).maybeSingle()
  return !!data
}

// Schedule the post-call sequence. Returns whether it actually went out, so the
// response can tell the coach the difference between "marked, follow-ups queued"
// and "marked, but you have no post-call emails built yet".
async function runPostCall(booking: Record<string, any>): Promise<boolean> {
  const funnelId = booking.funnel_id as string | null
  const email = typeof booking.email === 'string' ? booking.email : ''
  // Off-funnel bookings (the legacy shared calendar) have no funnel to draw the
  // coach's post-call emails or branding from. Attendance is still recorded.
  if (!funnelId || !email) return false

  const { data: funnel } = await supabase.from('funnels').select('*').eq('id', funnelId).maybeSingle()
  if (!funnel) return false

  // Resolve the lead the same way the booked event does: most recent lead on this
  // funnel with this email. Without one there is no unsubscribe binding and no
  // send record to attribute, so nothing is sent.
  const { data: lead } = await supabase
    .from('funnel_leads')
    .select('id')
    .eq('funnel_id', funnelId)
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!lead) return false

  await schedulePostCallEmails(funnel, lead.id as string, email, booking.id as string)
  return true
}
