import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireAdmin } from '../../../lib/auth'
import { setCors, noStore } from '../../../lib/cors'
import { COURSE_COLUMNS } from '../../../lib/course'

// GET  /api/admin/courses — the admin course list.
// POST /api/admin/courses — create a course.
//
// GET carries lesson_count and completion_count per course so the admin list
// can warn honestly before a delete: deleting a course cascades to its
// lessons and to every member completion and comment on them, and a confirm
// dialog that cannot say how much it is about to destroy is not a confirm
// dialog. Counting here rather than in the delete handler means the warning
// is on screen before the click, not after.
export const config = { maxDuration: 30 }

const TITLE_MAX = 200

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  if (req.method === 'GET') {
    try {
      const [{ data: courses, error: coursesError }, { data: lessons, error: lessonsError }, { data: progress, error: progressError }] =
        await Promise.all([
          supabase
            .from('courses')
            .select(COURSE_COLUMNS)
            .order('sort_order', { ascending: true })
            .order('title', { ascending: true }),
          supabase.from('course_lessons').select('id, course_id'),
          supabase.from('lesson_progress').select('lesson_id'),
        ])
      if (coursesError) throw coursesError
      if (lessonsError) throw lessonsError
      if (progressError) throw progressError

      const courseIdByLesson = new Map<string, string>((lessons || []).map((l: any) => [l.id, l.course_id]))
      const lessonCount = new Map<string, number>()
      for (const l of (lessons || []) as any[]) lessonCount.set(l.course_id, (lessonCount.get(l.course_id) || 0) + 1)

      const completionCount = new Map<string, number>()
      for (const p of (progress || []) as any[]) {
        const cid = courseIdByLesson.get(p.lesson_id)
        if (cid) completionCount.set(cid, (completionCount.get(cid) || 0) + 1)
      }

      return res.status(200).json({
        courses: (courses || []).map((c: any) => ({
          ...c,
          lesson_count: lessonCount.get(c.id) || 0,
          completion_count: completionCount.get(c.id) || 0,
        })),
      })
    } catch (err) {
      console.error('[admin/courses] GET', err)
      return res.status(500).json({ error: 'Failed to load courses' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return res.status(400).json({ error: 'invalid_field', field: 'title', message: 'title is required' })
  if (title.length > TITLE_MAX) {
    return res.status(400).json({ error: 'invalid_field', field: 'title', message: `max ${TITLE_MAX} characters` })
  }

  const insert: Record<string, unknown> = { title }
  if ('description' in body) insert.description = typeof body.description === 'string' ? body.description.trim() || null : null
  if ('cover_image_url' in body) {
    insert.cover_image_url = typeof body.cover_image_url === 'string' ? body.cover_image_url.trim() || null : null
  }
  if ('sort_order' in body) {
    if (!Number.isInteger(body.sort_order)) {
      return res.status(400).json({ error: 'invalid_field', field: 'sort_order', message: 'must be an integer' })
    }
    insert.sort_order = body.sort_order
  }

  try {
    const { data, error } = await supabase.from('courses').insert(insert).select(COURSE_COLUMNS).single()
    if (error) throw error
    return res.status(201).json({ course: { ...(data as any), lesson_count: 0, completion_count: 0 } })
  } catch (err) {
    console.error('[admin/courses] POST', err)
    return res.status(500).json({ error: 'Failed to create course' })
  }
}
