import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../lib/supabase'
import { requireActiveUser } from '../../../../lib/auth'
import { setCors, noStore } from '../../../../lib/cors'
import { parseLessonNumber, parseCourseId } from '../../../../lib/course'

// GET/POST /api/courses/:courseId/:lessonNumber/comments — the Discussion tab.
//
// The lesson lookup is filtered on BOTH course_id and lesson_number. Filtering
// on lesson_number alone was unambiguous while one course existed; now it
// would match some other course's lesson of the same number and thread the
// comment onto the wrong discussion.
const COMMENT_COLUMNS = 'id, content, created_at, user:users(id, name)'

export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const courseId = parseCourseId(req.query.courseId)
  if (!courseId) return res.status(400).json({ error: 'invalid course id' })

  const lessonNumber = parseLessonNumber(req.query.lessonNumber)
  if (lessonNumber === null) return res.status(400).json({ error: 'invalid lesson number' })

  const { data: lesson, error: lessonError } = await supabase
    .from('course_lessons')
    .select('id')
    .eq('course_id', courseId)
    .eq('lesson_number', lessonNumber)
    .maybeSingle()

  if (lessonError) {
    console.error('[courses/comments] lookup', lessonError)
    return res.status(500).json({ error: 'Failed to load lesson' })
  }
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' })

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('lesson_comments')
        .select(COMMENT_COLUMNS)
        .eq('lesson_id', lesson.id)
        .order('created_at', { ascending: true })
      if (error) throw error
      return res.status(200).json({ comments: data || [] })
    } catch (err) {
      console.error('[courses/comments] GET', err)
      return res.status(500).json({ error: 'Failed to load comments' })
    }
  }

  if (req.method === 'POST') {
    const { content } = req.body || {}
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content required' })
    }

    try {
      const { data, error } = await supabase
        .from('lesson_comments')
        .insert({ lesson_id: lesson.id, user_id: userId, content: content.trim() })
        .select(COMMENT_COLUMNS)
        .single()
      if (error) throw error
      return res.status(201).json({ comment: data })
    } catch (err) {
      console.error('[courses/comments] POST', err)
      return res.status(500).json({ error: 'Failed to create comment' })
    }
  }

  return res.status(405).end()
}
