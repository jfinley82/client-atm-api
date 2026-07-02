import { supabase } from './supabase'

export type LessonStatus = 'complete' | 'active' | 'locked'

/**
 * Load all course lessons (ordered by lesson_number) plus this user's
 * completion map (lesson_id -> completed_at).
 */
export async function getCourseState(userId: string): Promise<{
  lessons: any[]
  completedAtById: Map<string, string>
}> {
  const [{ data: lessons }, { data: progress }] = await Promise.all([
    supabase.from('course_lessons').select('*').order('lesson_number', { ascending: true }),
    supabase.from('lesson_progress').select('lesson_id, completed_at').eq('user_id', userId),
  ])

  const completedAtById = new Map<string, string>(
    (progress || []).map((p: any) => [p.lesson_id, p.completed_at])
  )
  return { lessons: lessons || [], completedAtById }
}

/**
 * Annotate ordered lessons with sequential-unlock status:
 *   - 'complete' if this user completed it
 *   - 'active'   if every earlier lesson is complete (lesson 1 is always at
 *     minimum active, since it has no predecessors)
 *   - 'locked'   if any earlier lesson is incomplete
 * Also attaches completed_at (null if not completed).
 */
export function withStatuses(
  lessons: any[],
  completedAtById: Map<string, string>
): Array<any & { status: LessonStatus; completed_at: string | null }> {
  let prevAllComplete = true
  return lessons.map((l) => {
    const completed = completedAtById.has(l.id)
    const status: LessonStatus = completed ? 'complete' : prevAllComplete ? 'active' : 'locked'
    prevAllComplete = prevAllComplete && completed
    return { ...l, status, completed_at: completedAtById.get(l.id) ?? null }
  })
}

// Parse a [lessonNumber] route param into a positive integer, or null if invalid.
export function parseLessonNumber(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}
