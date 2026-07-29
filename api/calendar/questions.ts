import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { resolveBookingQuestions } from '../../lib/bookingQuestions'

// GET /api/calendar/questions[?funnel_id=...] — public (the booking page is
// public). Returns the question definitions in order so the frontend can render
// them. Definitions only — no answers.
//
// funnel_id is REQUIRED for a funnel booking page. With it, the response comes
// from that funnel's own settings: application_questions_enabled=false yields [],
// true yields its booking_questions. WITHOUT it, this returns the LEGACY global
// admin set, which for a funnel is the wrong answer — that mismatch is what hard
// blocked bookings on charge-demo (the form showed no questions, the global
// defaults were validated against, every submission 400'd).
//
// /api/calendar/book resolves the same way from the same helper, so the set a
// lead is shown and the set they are validated against cannot drift.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  try {
    const raw = req.query.funnel_id
    const funnelId = Array.isArray(raw) ? raw[0] : raw
    const questions = await resolveBookingQuestions(funnelId)
    return res.status(200).json({ questions })
  } catch (err) {
    console.error('[calendar/questions] GET', err)
    return res.status(500).json({ error: 'Failed to load questions' })
  }
}
