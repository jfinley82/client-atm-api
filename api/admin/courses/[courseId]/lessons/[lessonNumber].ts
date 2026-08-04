import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { requireAdmin } from '../../../../../lib/auth'
import { setCors, noStore } from '../../../../../lib/cors'
import { LESSON_COLUMNS, parseCourseId, parseLessonNumber } from '../../../../../lib/course'

// PATCH  /api/admin/courses/:courseId/lessons/:lessonNumber
// DELETE /api/admin/courses/:courseId/lessons/:lessonNumber
//
// Every query filters on course_id AND lesson_number. lesson_number alone was
// unique while one course existed; now it identifies a lesson in every course
// at once, so filtering on it alone would edit or delete somebody else's.
export const config = { maxDuration: 30 }

const EDITABLE = new Set(['title', 'description', 'video_url', 'duration_minutes', 'lesson_number'])
const TITLE_MAX = 300

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  const courseId = parseCourseId(req.query.courseId)
  if (!courseId) return res.status(400).json({ error: 'invalid course id' })

  const lessonNumber = parseLessonNumber(req.query.lessonNumber)
  if (lessonNumber === null) return res.status(400).json({ error: 'invalid lesson number' })

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (!EDITABLE.has(key)) return res.status(400).json({ error: 'unknown_field', field: key })
    }

    const updates: Record<string, unknown> = {}
    if ('title' in body) {
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) return res.status(400).json({ error: 'invalid_field', field: 'title', message: 'title is required' })
      if (title.length > TITLE_MAX) {
        return res.status(400).json({ error: 'invalid_field', field: 'title', message: `max ${TITLE_MAX} characters` })
      }
      updates.title = title
    }
    if ('description' in body) updates.description = typeof body.description === 'string' ? body.description.trim() || null : null
    if ('video_url' in body) updates.video_url = typeof body.video_url === 'string' ? body.video_url.trim() || null : null
    if ('duration_minutes' in body) {
      if (body.duration_minutes !== null && (!Number.isInteger(body.duration_minutes) || (body.duration_minutes as number) < 0)) {
        return res.status(400).json({ error: 'invalid_field', field: 'duration_minutes', message: 'must be a non-negative integer' })
      }
      updates.duration_minutes = body.duration_minutes ?? null
    }
    // Renumbering is how a lesson is reordered.
    if ('lesson_number' in body) {
      if (!Number.isInteger(body.lesson_number) || (body.lesson_number as number) < 1) {
        return res.status(400).json({ error: 'invalid_field', field: 'lesson_number', message: 'must be a positive integer' })
      }
      updates.lesson_number = body.lesson_number
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' })

    try {
      const { data, error } = await supabase
        .from('course_lessons')
        .update(updates)
        .eq('course_id', courseId)
        .eq('lesson_number', lessonNumber)
        .select(LESSON_COLUMNS)
        .maybeSingle()
      if (error) {
        // Renumbering onto an occupied slot. Swapping two lessons therefore
        // needs a free number in between — reported clearly rather than as a
        // 500, since the caller can act on it.
        if ((error as { code?: string }).code === '23505') {
          return res.status(409).json({ error: 'lesson_number_taken', lesson_number: updates.lesson_number })
        }
        throw error
      }
      if (!data) return res.status(404).json({ error: 'Lesson not found' })
      return res.status(200).json({ lesson: data })
    } catch (err) {
      console.error('[admin/courses/[courseId]/lessons/[lessonNumber]] PATCH', err)
      return res.status(500).json({ error: 'Failed to update lesson' })
    }
  }

  if (req.method !== 'DELETE') return res.status(405).end()

  try {
    const { data: lesson } = await supabase
      .from('course_lessons')
      .select('id, title')
      .eq('course_id', courseId)
      .eq('lesson_number', lessonNumber)
      .maybeSingle()
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' })

    // Counted before the cascade removes them.
    const [{ count: completions }, { count: comments }] = await Promise.all([
      supabase.from('lesson_progress').select('id', { count: 'exact', head: true }).eq('lesson_id', (lesson as any).id),
      supabase.from('lesson_comments').select('id', { count: 'exact', head: true }).eq('lesson_id', (lesson as any).id),
    ])

    const { error } = await supabase.from('course_lessons').delete().eq('id', (lesson as any).id)
    if (error) throw error

    console.log(
      `[admin/courses/[courseId]/lessons/[lessonNumber]] DELETE course=${courseId} lesson=${lessonNumber} ` +
        `"${(lesson as any).title}" by admin=${adminId} cascaded completions=${completions || 0} comments=${comments || 0}`
    )

    // Deliberately does NOT renumber the remaining lessons. Shifting them
    // would move every later lesson out from under anyone mid-course, and the
    // unlock logic walks lessons by position rather than by arithmetic on
    // lesson_number, so a gap is harmless.
    return res.status(200).json({
      success: true,
      deleted: { lesson_number: lessonNumber, completions: completions || 0, comments: comments || 0 },
    })
  } catch (err) {
    console.error('[admin/courses/[courseId]/lessons/[lessonNumber]] DELETE', err)
    return res.status(500).json({ error: 'Failed to delete lesson' })
  }
}
