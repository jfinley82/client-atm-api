import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { QUIZ_PROBLEM_HELP, QUIZ_PROBLEM_PROMPT, servedQuestions } from '../../lib/quizScoring'

// GET /api/quiz/questions — authenticated. The quiz itself: seven prompts with
// their options, in order, plus the open question asked last.
//
// WHY THE BACKEND OWNS THE WORDS. Scoring is keyed by question id and letter, so
// what an answer is WORTH lives here. If the option text lived in the frontend,
// the two halves of one decision would sit in two repositories: writing option
// (a) on any question as the strongest answer would invert every score for that
// question — silently, with no error and no failing test, just wrong numbers
// under a coach's name. Serving the text removes the second place the meaning
// could live. This is the resolveBookingQuestions pattern and it exists for
// exactly this failure.
//
// POINTS ARE NOT IN THIS RESPONSE. The frontend renders labels and posts back a
// letter; the rubric stays server-side. Shipping it would put the answer key on
// the page of a self-assessment, and a coach who can see which option scores 4 is
// being invited to take a different quiz than the one that helps them.
//
// Static content, so no database is touched — but still authenticated, because
// /quiz is behind login and there is no reason to publish it more widely than
// the page that renders it.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const questions = servedQuestions()

  return res.status(200).json({
    questions,
    // Echoed so the progress counter reads "Question X of 7" from the served set
    // rather than from a 7 written into the frontend, which would go stale the
    // moment a question is added or removed here.
    total: questions.length,
    // The open question is deliberately NOT in `questions`: it is not scored,
    // does not auto-advance, and posts to a different field. Keeping it separate
    // means a frontend cannot render it into the scored loop by accident.
    problem_question: {
      prompt: QUIZ_PROBLEM_PROMPT,
      help: QUIZ_PROBLEM_HELP,
      field: 'problem_statement',
    },
  })
}
