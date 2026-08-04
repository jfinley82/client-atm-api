import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { requireActiveUser } from '../../../../lib/auth'
import { setCors, noStore } from '../../../../lib/cors'
import { getCourseState, courseProgress, parseLessonNumber, parseCourseId } from '../../../../lib/course'

// POST /api/courses/:courseId/:lessonNumber/complete
//
// The sequential-unlock check walks THIS course's lessons only. That is the
// substantive change from the old single-course route, which compared
// lesson_number globally: with more than one course that logic would gate
// course B's lesson 2 on course A's lesson 1, because both are "lesson 1".
// Scoping happens in getCourseState, so the comparison below cannot reach
// across courses even by accident.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
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

    const { lessons, completedAtById } = state
    const index = lessons.findIndex((l) => l.lesson_number === lessonNumber)
    if (index === -1) return res.status(404).json({ error: 'Lesson not found' })
    const lesson = lessons[index]

    // The preceding lesson IN THIS COURSE by position, not lesson_number - 1:
    // numbering is admin-editable and may have gaps once lessons can be
    // removed, and "lesson 5 was deleted" must not permanently wall off
    // lesson 6.
    if (index > 0) {
      const previous = lessons[index - 1]
      if (!completedAtById.has(previous.id)) {
        return res.status(403).json({ error: 'previous_lesson_incomplete' })
      }
    }

    // Idempotent: re-completing does nothing and keeps the original timestamp.
    const { error: upsertError } = await supabase
      .from('lesson_progress')
      .upsert({ user_id: userId, lesson_id: lesson.id }, { onConflict: 'user_id,lesson_id', ignoreDuplicates: true })
    if (upsertError) throw upsertError

    const { data: progress, error: fetchError } = await supabase
      .from('lesson_progress')
      .select('completed_at')
      .eq('user_id', userId)
      .eq('lesson_id', lesson.id)
      .single()
    if (fetchError) throw fetchError

    // Recomputed with this completion applied, so the player can update its
    // progress tracker without a follow-up round trip.
    completedAtById.set(lesson.id, progress.completed_at)

    return res.status(200).json({
      success: true,
      course_id: courseId,
      lesson_number: lessonNumber,
      completed_at: progress.completed_at,
      progress: courseProgress(lessons, completedAtById),
    })
  } catch (err) {
    console.error('[courses/[courseId]/[lessonNumber]/complete] POST', err)
    return res.status(500).json({ error: 'Failed to complete lesson' })
  }
}
