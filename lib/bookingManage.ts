import { supabase } from './supabase'
import { signManageToken } from './funnelLeadToken'

// Shared resolution for the lead-side booking manage flow (Phase 3b follow-up).
// bookings has no funnel_id / lead_id column, so the funnel + lead are resolved
// from coach_user_id + email — the same email match the booked-event log uses,
// widened to the coach's funnels.

const FUNNEL_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'

export type BookingRow = {
  id: string
  coach_user_id: string | null
  google_event_id: string | null
  meeting_url: string | null
  start_time: string
  end_time: string
  status: string
  email: string
  name: string | null
}

const BOOKING_COLUMNS = 'id, coach_user_id, google_event_id, meeting_url, start_time, end_time, status, email, name'

export async function loadBooking(bookingId: string): Promise<BookingRow | null> {
  const { data } = await supabase.from('bookings').select(BOOKING_COLUMNS).eq('id', bookingId).maybeSingle()
  return (data as BookingRow) ?? null
}

// Resolve the funnel this booking's manage flow acts on plus the lead behind it.
// funnel = the lead's own funnel when the lead resolves, else the coach's most
// recent live funnel (availability is per-COACH, so any of their funnels yields
// the same slots and subdomain for the availability fetch / manage URL). leadId
// is null when no matching lead exists (reminders then skip, best-effort).
export async function resolveFunnelAndLead(
  coachUserId: string,
  email: string
): Promise<{ funnel: Record<string, any> | null; leadId: string | null }> {
  const { data: funnels } = await supabase
    .from('funnels')
    .select('id, user_id, subdomain, nurture_emails, book_a_call_emails, watch_threshold_pct, status')
    .eq('user_id', coachUserId)
    .eq('status', 'live')
    .order('updated_at', { ascending: false })

  const liveFunnels = (funnels || []) as Record<string, any>[]
  if (!liveFunnels.length) return { funnel: null, leadId: null }

  const { data: lead } = await supabase
    .from('funnel_leads')
    .select('id, funnel_id')
    .eq('email', email)
    .in(
      'funnel_id',
      liveFunnels.map((f) => f.id)
    )
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lead) {
    const leadFunnel = liveFunnels.find((f) => f.id === (lead as { funnel_id: string }).funnel_id) || liveFunnels[0]
    return { funnel: leadFunnel, leadId: (lead as { id: string }).id }
  }
  // No lead match — still return a coach funnel so the manage page can show slots.
  return { funnel: liveFunnels[0], leadId: null }
}

// The manage link that goes in the booking emails, on the funnel's public domain
// (matches the training/book links the lead already clicked). vercel.json's
// rewrite excludes /api/, so this reaches the real function, not the renderer.
export function buildManageUrl(subdomain: string, bookingId: string): string {
  return `https://${subdomain}.${FUNNEL_DOMAIN}/api/funnel/booking?token=${encodeURIComponent(signManageToken(bookingId))}`
}

// Format an instant in the coach's timezone for the lead-facing copy.
export function formatInTz(iso: string, timezone: string | undefined): string {
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: timezone || 'UTC' })
  } catch {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })
  }
}
