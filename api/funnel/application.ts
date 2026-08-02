import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { resolveLiveFunnel } from '../../lib/funnels'
import { rateLimit, clientIp } from '../../lib/rateLimit'
import { verifyWatchToken } from '../../lib/funnelLeadToken'
import { funnelBookingQuestions, validateBookingAnswers, bookingQuestionErrorMessage } from '../../lib/bookingQuestions'
import { checkGate, gateApplies } from '../../lib/applicationGate'
import { sendCoachApplicationNotification } from '../../lib/email'

// POST /api/funnel/application — PUBLIC step 1 of the two-step booking page.
//
// The booking page only reveals the calendar after this endpoint says the lead
// qualifies, so this is where the application gate is decided for the SCREEN.
// It is not where it is enforced: /api/calendar/book calls the same checkGate()
// on the same answers, so a lead who skips this endpoint entirely is still
// rejected there and never written as a booking.
//
// Body: { subdomain?|funnel_id?, action?: 'start'|'submit', answers?, watch_token? }
//   - action 'start'  : logs application_started (the lead reached the quiz).
//   - action 'submit' : validates + evaluates, logs application_submitted and
//     then qualified | disqualified.
//   - watch_token (minted at opt-in, carried through the training page) NAMES the
//     lead so the events attribute and step 2 can greet them by name. It grants
//     nothing; an absent/expired token just means an anonymous funnel-level event
//     and a step 2 that asks for name + email as before.
//
// Answers are stored on the LEAD, not only on the booking: a disqualified lead
// never becomes a booking, and their answers are exactly what the coach needs to
// see to judge whether the rules are turning away the wrong people.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)
  if (req.method !== 'POST') return res.status(405).end()

  const ip = clientIp(req)
  if (!rateLimit(`funnel_application:${ip}`, 30, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const subdomain = typeof body.subdomain === 'string' ? body.subdomain.trim() : ''
  const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id.trim() : ''
  const action = body.action === 'start' ? 'start' : 'submit'
  const watchToken = typeof body.watch_token === 'string' ? body.watch_token : ''

  if (!subdomain && !funnelId) return res.status(400).json({ error: 'subdomain or funnel_id required' })

  const answersMap = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
    ? body.answers
    : {}) as Record<string, unknown>

  try {
    const funnel = await resolveLiveFunnel({ subdomain: subdomain || null, funnelId: funnelId || null })
    if (!funnel) return res.status(404).json({ error: 'funnel_not_found' })

    const questions = funnelBookingQuestions(funnel)
    // Gate off (or no questions): there is nothing to apply for. Answer honestly
    // rather than 400 — the page then behaves exactly as it does today.
    if (!gateApplies(funnel, questions)) return res.status(200).json({ gate: false, qualified: true })

    const lead = await resolveLead(watchToken, funnel.id as string)

    if (action === 'start') {
      await logEvent(funnel.id as string, lead?.id ?? null, 'application_started')
      return res.status(200).json({ ok: true })
    }

    // Same validator the booking handler runs, so a lead is never asked for
    // something here that book.ts would reject, or vice versa.
    const av = validateBookingAnswers(questions, answersMap)
    if (!av.ok) {
      return res
        .status(400)
        .json({ error: av.error, question: av.question, message: bookingQuestionErrorMessage(av.error, av.question) })
    }

    await logEvent(funnel.id as string, lead?.id ?? null, 'application_submitted')

    const outcome = checkGate(funnel, questions, answersMap)
    await logEvent(funnel.id as string, lead?.id ?? null, outcome.qualified ? 'qualified' : 'disqualified')

    if (lead) {
      // Best-effort: the outcome is already decided and logged, so a write failure
      // here must not turn a qualified lead away.
      const { error } = await supabase
        .from('funnel_leads')
        .update({
          application_answers: av.answers,
          application_status: outcome.qualified ? 'qualified' : 'disqualified',
          application_submitted_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
      if (error) console.error('[funnel/application] lead answers', error)

      // Coach notice (Phase 6). Best-effort — never fail or slow the response
      // the lead is waiting on. Fires even if the answers write above failed:
      // the application event itself already happened and was logged.
      await sendCoachApplicationNotification({
        funnel,
        leadId: lead.id,
        leadName: lead.name,
        leadEmail: lead.email,
        qualified: outcome.qualified,
      })
    }

    if (!outcome.qualified) {
      // 200, not 4xx: "not a fit" is a normal outcome of a valid submission, and
      // the page renders a real screen for it. No calendar is ever sent back.
      return res.status(200).json({
        gate: true,
        qualified: false,
        action: outcome.action,
        message: outcome.message,
        redirect_url: outcome.redirect_url,
      })
    }

    return res.status(200).json({
      gate: true,
      qualified: true,
      // Names the already-opted-in lead so step 2 can say "Booking as …" instead
      // of asking for details they have already given. Null when unidentified.
      lead: lead ? { name: lead.name, email: lead.email } : null,
    })
  } catch (err) {
    console.error('[funnel/application] POST', err)
    return res.status(500).json({ error: 'Failed to submit application' })
  }
}

// ---- helpers ----------------------------------------------------------------

type GateLead = { id: string; name: string; email: string }

// Resolve the lead the watch token names, confirming it still belongs to THIS
// funnel. Any failure (missing, tampered, expired, foreign) yields null and the
// flow continues anonymously — the gate decision never depends on it.
async function resolveLead(watchToken: string, funnelId: string): Promise<GateLead | null> {
  if (!watchToken) return null
  const leadId = verifyWatchToken(watchToken, funnelId)
  if (!leadId) return null

  const { data } = await supabase
    .from('funnel_leads')
    .select('id, first_name, email')
    .eq('id', leadId)
    .eq('funnel_id', funnelId)
    .maybeSingle()
  if (!data) return null

  return {
    id: data.id as string,
    name: typeof data.first_name === 'string' ? data.first_name.trim() : '',
    email: typeof data.email === 'string' ? data.email : '',
  }
}

async function logEvent(funnelId: string, leadId: string | null, eventType: string): Promise<void> {
  const { error } = await supabase
    .from('funnel_events')
    .insert({ funnel_id: funnelId, lead_id: leadId, event_type: eventType })
  if (error) console.error('[funnel/application] logEvent', eventType, error)
}
