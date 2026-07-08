import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors } from '../../lib/cors'

// DEPRECATED — do not resurrect. This predates the Matcher redesign
// (api/matcher/{analyze,selection,finalize}.ts) and accepted the OLD
// pre-redesign card shape (surface_problem/real_problem/your_solution/...)
// with a bare `validated` boolean taken straight from the request body — no
// relation to matcher_analysis, no check that submitted ids came from a real
// top_10, nothing. It structurally cannot be made safe without duplicating
// finalize.ts's real validation, so there is now exactly one path to create a
// problem_solution_cards row: analyze -> selection -> finalize.
//
// Confirmed via a live query before removal: zero corrupted rows existed in
// production (validated:true with every content field null), so there was
// nothing to migrate or clean up.
//
// Returns 410 Gone (not a bare 404) so a frontend still pointed at this route
// gets a clear, unambiguous signal to switch to the finalize flow instead of
// a silent/confusing "not found".
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  return res.status(410).json({
    error: 'gone',
    message: 'This endpoint is deprecated. Create problem_solution_cards rows via POST /api/matcher/finalize instead.',
  })
}
