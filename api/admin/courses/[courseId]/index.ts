import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { requireAdmin } from '../../../../lib/auth'
import { setCors, noStore } from '../../../../lib/cors'
import { COURSE_COLUMNS, LESSON_COLUMNS, parseCourseId } from '../../../../lib/course'

// GET    /api/admin/courses/:courseId — course + its lessons, for the editor.
// PATCH  /api/admin/courses/:courseId — title/description/cover/sort_order.
// DELETE /api/admin/courses/:courseId — delete the course.
//
// DELETE cascades: courses -> course_lessons -> lesson_progress and
// lesson_comments, all ON DELETE CASCADE. That is the specified behavior, so
// this does not block the delete — but it counts what is about to go first and
// returns it, so the action is legible in the response and in the log rather
// than silently taking member history with it.
export const config = { maxDuration: 30 }

const EDITABLE = new Set(['title', 'description', 'cover_image_url', 'sort_order'])
const TITLE_MAX = 200

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  const courseId = parseCourseId(req.query.courseId)
  if (!courseId) return res.status(400).json({ error: 'invalid course id' })

  if (req.method === 'GET') {
    try {
      const { data: course } = await supabase.from('courses').select(COURSE_COLUMNS).eq('id', courseId).maybeSingle()
      if (!course) return res.status(404).json({ error: 'Course not found' })

      const { data: lessons, error } = await supabase
        .from('course_lessons')
        .select(LESSON_COLUMNS)
        .eq('course_id', courseId)
        .order('lesson_number', { ascending: true })
      if (error) throw error

      return res.status(200).json({ course, lessons: lessons || [] })
    } catch (err) {
      console.error('[admin/courses/[courseId]] GET', err)
      return res.status(500).json({ error: 'Failed to load course' })
    }
  }

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
    // Empty string normalizes to null so "cleared" is one value in the data,
    // not two the frontend has to test for separately.
    if ('description' in body) {
      updates.description = typeof body.description === 'string' ? body.description.trim() || null : null
    }
    if ('cover_image_url' in body) {
      updates.cover_image_url = typeof body.cover_image_url === 'string' ? body.cover_image_url.trim() || null : null
    }
    if ('sort_order' in body) {
      if (!Number.isInteger(body.sort_order)) {
        return res.status(400).json({ error: 'invalid_field', field: 'sort_order', message: 'must be an integer' })
      }
      updates.sort_order = body.sort_order
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' })
    updates.updated_at = new Date().toISOString()

    try {
      const { data, error } = await supabase
        .from('courses')
        .update(updates)
        .eq('id', courseId)
        .select(COURSE_COLUMNS)
        .maybeSingle()
      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Course not found' })
      return res.status(200).json({ course: data })
    } catch (err) {
      console.error('[admin/courses/[courseId]] PATCH', err)
      return res.status(500).json({ error: 'Failed to update course' })
    }
  }

  if (req.method !== 'DELETE') return res.status(405).end()

  try {
    const { data: course } = await supabase.from('courses').select('id, title').eq('id', courseId).maybeSingle()
    if (!course) return res.status(404).json({ error: 'Course not found' })

    // Counted BEFORE the delete — afterwards the rows are gone and there is
    // nothing left to report.
    const { data: lessons } = await supabase.from('course_lessons').select('id').eq('course_id', courseId)
    const lessonIds = (lessons || []).map((l: any) => l.id)

    let completions = 0
    let comments = 0
    if (lessonIds.length) {
      const [{ count: progressCount }, { count: commentCount }] = await Promise.all([
        supabase.from('lesson_progress').select('id', { count: 'exact', head: true }).in('lesson_id', lessonIds),
        supabase.from('lesson_comments').select('id', { count: 'exact', head: true }).in('lesson_id', lessonIds),
      ])
      completions = progressCount || 0
      comments = commentCount || 0
    }

    const { error } = await supabase.from('courses').delete().eq('id', courseId)
    if (error) throw error

    console.log(
      `[admin/courses/[courseId]] DELETE course=${courseId} "${(course as any).title}" by admin=${adminId} ` +
        `cascaded lessons=${lessonIds.length} completions=${completions} comments=${comments}`
    )

    return res.status(200).json({
      success: true,
      deleted: { course_id: courseId, lessons: lessonIds.length, completions, comments },
    })
  } catch (err) {
    console.error('[admin/courses/[courseId]] DELETE', err)
    return res.status(500).json({ error: 'Failed to delete course' })
  }
}
