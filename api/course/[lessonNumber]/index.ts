import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getCourseState, withStatuses, parseLessonNumber } from '../../../lib/course'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const lessonNumber = parseLessonNumber(req.query.lessonNumber)
  if (lessonNumber === null) return res.status(400).json({ error: 'invalid lesson number' })

  try {
    const { lessons, completedAtById } = await getCourseState(userId)
    const withStatus = withStatuses(lessons, completedAtById)
    const lesson = withStatus.find((l) => l.lesson_number === lessonNumber)

    if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
    if (lesson.status === 'locked') return res.status(403).json({ error: 'lesson_locked' })

    return res.status(200).json({ lesson })
  } catch (err) {
    console.error('[course/[lessonNumber]] GET', err)
    return res.status(500).json({ error: 'Failed to load lesson' })
  }
}
