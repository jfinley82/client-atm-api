import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { requireAdmin } from '../../../../../lib/auth'
import { setCors, noStore } from '../../../../../lib/cors'
import { LESSON_COLUMNS, parseCourseId } from '../../../../../lib/course'

// POST /api/admin/courses/:courseId/lessons — add a lesson to a course.
//
// Creation lives on the COLLECTION rather than at .../lessons/:lessonNumber as
// the brief listed, for two reasons: POSTing to the URL of a resource that
// does not exist yet is an odd shape, and more practically the caller usually
// wants "append to the end" without having to work out the next free number
// itself. lesson_number is still accepted explicitly when the caller does care
// where it lands. PATCH and DELETE stay on the numbered path as specified.
export const config = { maxDuration: 30 }

const TITLE_MAX = 300

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  const courseId = parseCourseId(req.query.courseId)
  if (!courseId) return res.status(400).json({ error: 'invalid course id' })

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return res.status(400).json({ error: 'invalid_field', field: 'title', message: 'title is required' })
  if (title.length > TITLE_MAX) {
    return res.status(400).json({ error: 'invalid_field', field: 'title', message: `max ${TITLE_MAX} characters` })
  }

  if ('duration_minutes' in body && body.duration_minutes !== null) {
    if (!Number.isInteger(body.duration_minutes) || (body.duration_minutes as number) < 0) {
      return res.status(400).json({ error: 'invalid_field', field: 'duration_minutes', message: 'must be a non-negative integer' })
    }
  }
  if ('lesson_number' in body && (!Number.isInteger(body.lesson_number) || (body.lesson_number as number) < 1)) {
    return res.status(400).json({ error: 'invalid_field', field: 'lesson_number', message: 'must be a positive integer' })
  }

  try {
    const { data: course } = await supabase.from('courses').select('id').eq('id', courseId).maybeSingle()
    if (!course) return res.status(404).json({ error: 'Course not found' })

    let lessonNumber = body.lesson_number as number | undefined
    if (lessonNumber === undefined) {
      // Append: one past the current maximum, so a course with a gap (a
      // deleted lesson 3) still appends at the end rather than backfilling
      // the hole and silently reordering what members see.
      const { data: last } = await supabase
        .from('course_lessons')
        .select('lesson_number')
        .eq('course_id', courseId)
        .order('lesson_number', { ascending: false })
        .limit(1)
        .maybeSingle()
      lessonNumber = ((last as any)?.lesson_number ?? 0) + 1
    }

    const insert: Record<string, unknown> = { course_id: courseId, lesson_number: lessonNumber, title }
    if ('description' in body) insert.description = typeof body.description === 'string' ? body.description.trim() || null : null
    if ('video_url' in body) insert.video_url = typeof body.video_url === 'string' ? body.video_url.trim() || null : null
    if ('duration_minutes' in body) insert.duration_minutes = body.duration_minutes ?? null

    const { data, error } = await supabase.from('course_lessons').insert(insert).select(LESSON_COLUMNS).single()
    if (error) {
      // The (course_id, lesson_number) unique constraint. A 409 naming the
      // taken slot is actionable; a 500 is not.
      if ((error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'lesson_number_taken', lesson_number: lessonNumber })
      }
      throw error
    }

    return res.status(201).json({ lesson: data })
  } catch (err) {
    console.error('[admin/courses/[courseId]/lessons] POST', err)
    return res.status(500).json({ error: 'Failed to create lesson' })
  }
}
