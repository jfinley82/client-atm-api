import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { resolveBookingQuestions } from '../../lib/bookingQuestions'

// GET /api/calendar/questions[?funnel_id=...] — public (the booking page is
// public). Returns the question definitions in order so the frontend can render
// them. Definitions only — no answers.
//
// funnel_id is REQUIRED for a funnel booking page: /api/calendar/book validates
// against the funnel's own questions when the coach has Google connected, and the
// global set otherwise. Without funnel_id this returns the global set, which for
// a funnel booking can be the WRONG set — the live `question_required` bug, where
// the lead was rejected for a field the form never showed. resolveBookingQuestions
// is the single resolver both sides use.
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
