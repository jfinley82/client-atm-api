import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'
import { getCourseState, withStatuses, courseProgress, parseCourseId } from '../../../lib/course'

// GET /api/courses/:courseId — one course, its lessons with per-lesson
// unlock status, and this member's progress through it. Backs the course
// player's outline + progress tracker.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const courseId = parseCourseId(req.query.courseId)
  if (!courseId) return res.status(400).json({ error: 'invalid course id' })

  try {
    const state = await getCourseState(userId, courseId)
    if (!state) return res.status(404).json({ error: 'Course not found' })

    return res.status(200).json({
      course: { ...state.course, ...courseProgress(state.lessons, state.completedAtById) },
      lessons: withStatuses(state.lessons, state.completedAtById),
    })
  } catch (err) {
    console.error('[courses/[courseId]] GET', err)
    return res.status(500).json({ error: 'Failed to load course' })
  }
}
