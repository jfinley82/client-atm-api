import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { COURSE_COLUMNS, courseProgress } from '../../lib/course'

// GET /api/courses — the Training grid: every course with this member's
// per-course progress summary.
//
// Two queries total, not one per course: all lessons and all of this member's
// completions are fetched once and grouped in memory, so adding courses does
// not add round trips.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const [{ data: courses, error: coursesError }, { data: lessons, error: lessonsError }, { data: progress, error: progressError }] =
      await Promise.all([
        supabase
          .from('courses')
          .select(COURSE_COLUMNS)
          // sort_order is the intended order, but it defaults to 0, so any two
          // courses created without one tie. title breaks the tie, keeping the
          // grid stable between loads instead of reshuffling.
          .order('sort_order', { ascending: true })
          .order('title', { ascending: true }),
        supabase.from('course_lessons').select('id, course_id, lesson_number').order('lesson_number', { ascending: true }),
        supabase.from('lesson_progress').select('lesson_id, completed_at').eq('user_id', userId),
      ])
    if (coursesError) throw coursesError
    if (lessonsError) throw lessonsError
    if (progressError) throw progressError

    const completedAtById = new Map<string, string>((progress || []).map((p: any) => [p.lesson_id, p.completed_at]))

    const lessonsByCourse = new Map<string, any[]>()
    for (const l of (lessons || []) as any[]) {
      const bucket = lessonsByCourse.get(l.course_id)
      if (bucket) bucket.push(l)
      else lessonsByCourse.set(l.course_id, [l])
    }

    return res.status(200).json({
      courses: (courses || []).map((c: any) => ({
        ...c,
        ...courseProgress(lessonsByCourse.get(c.id) || [], completedAtById),
      })),
    })
  } catch (err) {
    console.error('[courses] GET', err)
    return res.status(500).json({ error: 'Failed to load courses' })
  }
}
