import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { parseLessonNumber } from '../../../lib/course'

// Fields an admin may update on a fixed lesson (the lesson set itself is seeded)
const UPDATABLE_FIELDS = ['video_url', 'title', 'description', 'duration_minutes'] as const

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'PATCH') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const { data: actingUser } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (!actingUser || actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const lessonNumber = parseLessonNumber(req.query.lessonNumber)
  if (lessonNumber === null) return res.status(400).json({ error: 'invalid lesson number' })

  const body = req.body || {}
  const updates: Record<string, unknown> = {}
  for (const field of UPDATABLE_FIELDS) {
    if (field in body) updates[field] = body[field]
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' })
  }

  try {
    const { data, error } = await supabase
      .from('course_lessons')
      .update(updates)
      .eq('lesson_number', lessonNumber)
      .select('*')
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Lesson not found' })

    return res.status(200).json({ lesson: data })
  } catch (err) {
    console.error('[admin/course/[lessonNumber]] PATCH', err)
    return res.status(500).json({ error: 'Failed to update lesson' })
  }
}
