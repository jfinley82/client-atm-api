import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { loadBookingQuestions } from '../../lib/bookingQuestions'

// GET /api/calendar/questions — public (the booking page is public). Returns
// the active custom question definitions in order so the frontend can render
// them. Definitions only — no answers.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  try {
    const questions = await loadBookingQuestions()
    return res.status(200).json({ questions })
  } catch (err) {
    console.error('[calendar/questions] GET', err)
    return res.status(500).json({ error: 'Failed to load questions' })
  }
}
