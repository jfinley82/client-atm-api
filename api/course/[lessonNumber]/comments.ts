import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { parseLessonNumber } from '../../../lib/course'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const lessonNumber = parseLessonNumber(req.query.lessonNumber)
  if (lessonNumber === null) return res.status(400).json({ error: 'invalid lesson number' })

  // Resolve lesson_number -> lesson id
  const { data: lesson, error: lessonError } = await supabase
    .from('course_lessons')
    .select('id')
    .eq('lesson_number', lessonNumber)
    .maybeSingle()

  if (lessonError) {
    console.error('[course/comments] lookup', lessonError)
    return res.status(500).json({ error: 'Failed to load lesson' })
  }
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' })

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('lesson_comments')
        .select('id, content, created_at, user:users(id, name)')
        .eq('lesson_id', lesson.id)
        .order('created_at', { ascending: true })

      if (error) throw error
      return res.status(200).json({ comments: data || [] })
    } catch (err) {
      console.error('[course/comments] GET', err)
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
        .select('id, content, created_at, user:users(id, name)')
        .single()

      if (error) throw error
      return res.status(200).json({ comment: data })
    } catch (err) {
      console.error('[course/comments] POST', err)
      return res.status(500).json({ error: 'Failed to create comment' })
    }
  }

  return res.status(405).end()
}
