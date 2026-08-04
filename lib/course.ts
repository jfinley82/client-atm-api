import { supabase } from './supabase'

export type LessonStatus = 'complete' | 'active' | 'locked'

export const LESSON_COLUMNS = 'id, course_id, lesson_number, title, description, video_url, duration_minutes, created_at'
export const COURSE_COLUMNS = 'id, title, description, cover_image_url, sort_order, created_at, updated_at'

export type Course = {
  id: string
  title: string
  description: string | null
  cover_image_url: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

/**
 * Load ONE course's lessons (ordered by lesson_number) plus this user's
 * completion map (lesson_id -> completed_at).
 *
 * Course-scoped by construction rather than by filtering afterwards: every
 * unlock decision downstream reads whatever this returns, so scoping here is
 * what stops lesson 2 of course B being gated on course A's lesson 1.
 * Returns null when the course does not exist, so callers 404 rather than
 * rendering an empty course that looks real.
 */
export async function getCourseState(
  userId: string,
  courseId: string
): Promise<{ course: Course; lessons: any[]; completedAtById: Map<string, string> } | null> {
  const { data: course } = await supabase.from('courses').select(COURSE_COLUMNS).eq('id', courseId).maybeSingle()
  if (!course) return null

  const [{ data: lessons }, { data: progress }] = await Promise.all([
    supabase
      .from('course_lessons')
      .select(LESSON_COLUMNS)
      .eq('course_id', courseId)
      .order('lesson_number', { ascending: true }),
    supabase.from('lesson_progress').select('lesson_id, completed_at').eq('user_id', userId),
  ])

  // The progress query is per-user, not per-course — a member's completions
  // span every course. Keying by lesson_id makes that harmless: only lessons
  // in THIS course are ever looked up against the map.
  const completedAtById = new Map<string, string>((progress || []).map((p: any) => [p.lesson_id, p.completed_at]))
  return { course: course as Course, lessons: lessons || [], completedAtById }
}

/**
 * Annotate ordered lessons with sequential-unlock status:
 *   - 'complete' if this user completed it
 *   - 'active'   if every earlier lesson is complete (lesson 1 is always at
 *     minimum active, since it has no predecessors)
 *   - 'locked'   if any earlier lesson is incomplete
 * Also attaches completed_at (null if not completed).
 *
 * Operates purely on the array it is handed, so it is only ever as
 * course-scoped as its input — always feed it one course's lessons.
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

/**
 * Per-course progress for the Training grid: how many of this course's
 * lessons the member has completed, and which lesson Start/Continue opens.
 *
 * resume_lesson_number is the first incomplete lesson, falling back to the
 * first lesson when the course is finished — so Continue on a completed
 * course replays it from the top rather than dead-ending. null when the
 * course has no lessons yet, so the card renders without a broken link.
 *
 * Uses the first lesson's actual number rather than a hardcoded 1: lesson
 * numbering is admin-editable, so a course whose lessons start at 0 or 2 must
 * still resume somewhere real.
 */
export function courseProgress(lessons: any[], completedAtById: Map<string, string>) {
  const total = lessons.length
  const completed = lessons.filter((l) => completedAtById.has(l.id)).length
  const firstIncomplete = lessons.find((l) => !completedAtById.has(l.id))
  return {
    total_lessons: total,
    completed_lessons: completed,
    resume_lesson_number: total === 0 ? null : firstIncomplete?.lesson_number ?? lessons[0].lesson_number,
  }
}

// Parse a [lessonNumber] route param into a positive integer, or null if invalid.
export function parseLessonNumber(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse a [courseId] route param. Validated as a UUID before it reaches
 * PostgREST: an id like "abc" would otherwise come back as a 22P02
 * invalid-input error and surface as a 500, when the honest answer is a 400.
 */
export function parseCourseId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed : null
}
