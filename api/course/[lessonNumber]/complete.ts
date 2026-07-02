import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getCourseState, parseLessonNumber } from '../../../lib/course'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const lessonNumber = parseLessonNumber(req.query.lessonNumber)
  if (lessonNumber === null) return res.status(400).json({ error: 'invalid lesson number' })

  try {
    const { lessons, completedAtById } = await getCourseState(userId)
    const lesson = lessons.find((l) => l.lesson_number === lessonNumber)
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' })

    // Sequential unlock: the immediately previous lesson must be complete (skip for lesson 1)
    if (lessonNumber > 1) {
      const previous = lessons.find((l) => l.lesson_number === lessonNumber - 1)
      if (!previous || !completedAtById.has(previous.id)) {
        return res.status(403).json({ error: 'previous_lesson_incomplete' })
      }
    }

    // Idempotent: do nothing if already completed
    const { error: upsertError } = await supabase
      .from('lesson_progress')
      .upsert(
        { user_id: userId, lesson_id: lesson.id },
        { onConflict: 'user_id,lesson_id', ignoreDuplicates: true }
      )
    if (upsertError) throw upsertError

    const { data: progress, error: fetchError } = await supabase
      .from('lesson_progress')
      .select('completed_at')
      .eq('user_id', userId)
      .eq('lesson_id', lesson.id)
      .single()
    if (fetchError) throw fetchError

    return res.status(200).json({
      success: true,
      lesson_number: lessonNumber,
      completed_at: progress.completed_at,
    })
  } catch (err) {
    console.error('[course/[lessonNumber]/complete] POST', err)
    return res.status(500).json({ error: 'Failed to complete lesson' })
  }
}
