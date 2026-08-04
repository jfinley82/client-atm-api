import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../../lib/auth'
import { setCors, noStore } from '../../../../lib/cors'
import { getCourseState, withStatuses, parseLessonNumber, parseCourseId } from '../../../../lib/course'

// GET /api/courses/:courseId/:lessonNumber — one lesson, gated on this
// member's progress THROUGH THAT COURSE.
//
// The course is echoed back alongside the lesson so the player can title
// itself ("Part of <course title>") from the response it already has, rather
// than hardcoding a course name or making a second request for it.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const courseId = parseCourseId(req.query.courseId)
  if (!courseId) return res.status(400).json({ error: 'invalid course id' })

  const lessonNumber = parseLessonNumber(req.query.lessonNumber)
  if (lessonNumber === null) return res.status(400).json({ error: 'invalid lesson number' })

  try {
    const state = await getCourseState(userId, courseId)
    if (!state) return res.status(404).json({ error: 'Course not found' })

    const withStatus = withStatuses(state.lessons, state.completedAtById)
    const lesson = withStatus.find((l) => l.lesson_number === lessonNumber)

    if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
    if (lesson.status === 'locked') return res.status(403).json({ error: 'lesson_locked' })

    return res.status(200).json({ lesson, course: state.course })
  } catch (err) {
    console.error('[courses/[courseId]/[lessonNumber]] GET', err)
    return res.status(500).json({ error: 'Failed to load lesson' })
  }
}
