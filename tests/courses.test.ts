process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { projectSelect } from './support/postgrest'
import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const MEMBER = 'member-1'
const ADMIN = 'admin-1'
const COURSE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const COURSE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const NOW = '2026-08-04T12:00:00.000Z'

type Lesson = { id: string; course_id: string; lesson_number: number; title: string; description?: string | null; video_url?: string | null; duration_minutes?: number | null; created_at?: string }
type Course = { id: string; title: string; description: string | null; cover_image_url: string | null; sort_order: number; created_at: string; updated_at: string }

let users: Record<string, any> = {}
let courses: Course[] = []
let lessons: Lesson[] = []
let progress: { user_id: string; lesson_id: string; completed_at: string }[] = []
let comments: any[] = []

function mkCourse(id: string, o: Partial<Course> = {}): Course {
  return { id, title: `Course ${id.slice(0, 1).toUpperCase()}`, description: null, cover_image_url: null, sort_order: 1, created_at: NOW, updated_at: NOW, ...o }
}
function mkLesson(id: string, courseId: string, n: number, o: Partial<Lesson> = {}): Lesson {
  return { id, course_id: courseId, lesson_number: n, title: `Lesson ${n}`, description: null, video_url: null, duration_minutes: null, created_at: NOW, ...o }
}

function reset() {
  users = {
    [MEMBER]: { name: 'Jamie', email: 'jamie@example.com', status: 'active', role: 'member', membership_tier: 'full', add_ons: {} },
    [ADMIN]: { name: 'Ada', email: 'ada@example.com', status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} },
  }
  // Two courses, each with lessons numbered from 1 — impossible before the
  // migration, and the whole point of it.
  courses = [mkCourse(COURSE_A, { title: 'The Micro Method', sort_order: 1 }), mkCourse(COURSE_B, { title: 'Second Course', sort_order: 2 })]
  lessons = [
    mkLesson('a1', COURSE_A, 1), mkLesson('a2', COURSE_A, 2), mkLesson('a3', COURSE_A, 3),
    mkLesson('b1', COURSE_B, 1), mkLesson('b2', COURSE_B, 2),
  ]
  progress = []
  comments = []
}

function eqParam(url: string, key: string): string | null {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
function inParam(url: string, key: string): string[] | null {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((s) => decodeURIComponent(s).replace(/^"|"$/g, '')) : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(projectSelect(url, b, status)), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  // head:true count requests come back as a Content-Range header, not a body.
  const countRes = (n: number) => new Response(null, { status: 200, headers: { 'Content-Range': `0-${Math.max(0, n - 1)}/${n}` } })
  const isCount = /count=exact/.test(String(init?.headers?.Prefer || init?.headers?.prefer || '')) || method === 'HEAD'

  if (url.includes('/rest/v1/users')) {
    const id = eqParam(url, 'id')
    return json(id && users[id] ? { id, ...users[id] } : null)
  }

  if (url.includes('/rest/v1/courses')) {
    const id = eqParam(url, 'id')
    if (method === 'POST') {
      const row: Course = { id: `new-course-${courses.length + 1}`, title: body.title, description: body.description ?? null, cover_image_url: body.cover_image_url ?? null, sort_order: body.sort_order ?? 0, created_at: NOW, updated_at: NOW }
      courses.push(row)
      return json(row, 201)
    }
    if (method === 'PATCH' && id) {
      const row = courses.find((c) => c.id === id)
      if (row) Object.assign(row, body)
      return json(row ?? null)
    }
    if (method === 'DELETE' && id) {
      const victimLessons = lessons.filter((l) => l.course_id === id).map((l) => l.id)
      courses = courses.filter((c) => c.id !== id)
      // Mirror the real ON DELETE CASCADE chain.
      lessons = lessons.filter((l) => l.course_id !== id)
      progress = progress.filter((p) => !victimLessons.includes(p.lesson_id))
      comments = comments.filter((c) => !victimLessons.includes(c.lesson_id))
      return json({})
    }
    if (id) return json(courses.find((c) => c.id === id) ?? null)
    const sorted = [...courses].sort((a, b) => (a.sort_order - b.sort_order) || a.title.localeCompare(b.title))
    return json(sorted)
  }

  if (url.includes('/rest/v1/course_lessons')) {
    const courseId = eqParam(url, 'course_id')
    const n = eqParam(url, 'lesson_number')
    const id = eqParam(url, 'id')
    if (method === 'POST') {
      if (lessons.some((l) => l.course_id === body.course_id && l.lesson_number === body.lesson_number)) {
        return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409)
      }
      const row = mkLesson(`new-${lessons.length + 1}`, body.course_id, body.lesson_number, body)
      lessons.push(row)
      return json(row, 201)
    }
    if (method === 'PATCH') {
      const row = lessons.find((l) => (!courseId || l.course_id === courseId) && (!n || l.lesson_number === Number(n)))
      if (!row) return json(null)
      if (body.lesson_number !== undefined && lessons.some((l) => l.course_id === row.course_id && l.lesson_number === body.lesson_number && l.id !== row.id)) {
        return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409)
      }
      Object.assign(row, body)
      return json(row)
    }
    if (method === 'DELETE') {
      const victim = lessons.find((l) => (id ? l.id === id : (!courseId || l.course_id === courseId) && (!n || l.lesson_number === Number(n))))
      if (victim) {
        lessons = lessons.filter((l) => l.id !== victim.id)
        progress = progress.filter((p) => p.lesson_id !== victim.id)
        comments = comments.filter((c) => c.lesson_id !== victim.id)
      }
      return json({})
    }
    let rows = lessons.slice()
    if (courseId) rows = rows.filter((l) => l.course_id === courseId)
    if (n) rows = rows.filter((l) => l.lesson_number === Number(n))
    if (id) rows = rows.filter((l) => l.id === id)
    rows = rows.sort((a, b) => a.lesson_number - b.lesson_number)
    if (/order=lesson_number\.desc/.test(url)) rows = rows.reverse()
    if (/limit=1/.test(url)) return json(rows[0] ?? null)
    return json(rows)
  }

  if (url.includes('/rest/v1/lesson_progress')) {
    const userId = eqParam(url, 'user_id')
    const lessonId = eqParam(url, 'lesson_id')
    const lessonIds = inParam(url, 'lesson_id')
    if (method === 'POST') {
      if (!progress.some((p) => p.user_id === body.user_id && p.lesson_id === body.lesson_id)) {
        progress.push({ user_id: body.user_id, lesson_id: body.lesson_id, completed_at: NOW })
      }
      return json({})
    }
    let rows = progress.slice()
    if (userId) rows = rows.filter((p) => p.user_id === userId)
    if (lessonId) rows = rows.filter((p) => p.lesson_id === lessonId)
    if (lessonIds) rows = rows.filter((p) => lessonIds.includes(p.lesson_id))
    if (isCount) return countRes(rows.length)
    if (/limit=1/.test(url) || lessonId) return json(rows[0] ?? null)
    return json(rows)
  }

  if (url.includes('/rest/v1/lesson_comments')) {
    const lessonId = eqParam(url, 'lesson_id')
    const lessonIds = inParam(url, 'lesson_id')
    if (method === 'POST') {
      const row = { id: `c${comments.length + 1}`, lesson_id: body.lesson_id, content: body.content, created_at: NOW, user: { id: body.user_id, name: users[body.user_id]?.name ?? null } }
      comments.push(row)
      return json(row, 201)
    }
    let rows = comments.slice()
    if (lessonId) rows = rows.filter((c) => c.lesson_id === lessonId)
    if (lessonIds) rows = rows.filter((c) => lessonIds.includes(c.lesson_id))
    if (isCount) return countRes(rows.length)
    return json(rows)
  }

  return json([])
}) as typeof fetch

async function call(handler: Handler, opts: { user?: string; method?: string; body?: any; query?: any } = {}) {
  const token = await createSessionToken(opts.user || MEMBER)
  let status = 0, resBody: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { resBody = v; return res }, end() { return res } }
  await handler({ headers: { authorization: `Bearer ${token}` }, method: opts.method || 'GET', body: opts.body, query: opts.query || {} } as any, res)
  return { status, body: resBody }
}

;(async () => {
  const list: Handler = (await import('../api/courses/index')).default
  const detail: Handler = (await import('../api/courses/[courseId]/index')).default
  const lesson: Handler = (await import('../api/courses/[courseId]/[lessonNumber]/index')).default
  const complete: Handler = (await import('../api/courses/[courseId]/[lessonNumber]/complete')).default
  const lessonComments: Handler = (await import('../api/courses/[courseId]/[lessonNumber]/comments')).default
  const adminList: Handler = (await import('../api/admin/courses/index')).default
  const adminCourse: Handler = (await import('../api/admin/courses/[courseId]/index')).default
  const adminLessons: Handler = (await import('../api/admin/courses/[courseId]/lessons/index')).default
  const adminLesson: Handler = (await import('../api/admin/courses/[courseId]/lessons/[lessonNumber]')).default

  console.log('\n-- GET /api/courses: the Training grid --')
  reset()
  const grid = await call(list)
  ok('200', grid.status === 200, JSON.stringify(grid.body).slice(0, 200))
  ok('both courses listed', grid.body?.courses?.length === 2)
  ok('ordered by sort_order', grid.body?.courses?.[0]?.title === 'The Micro Method')
  ok('per-course lesson totals, not a global count', grid.body?.courses?.[0]?.total_lessons === 3 && grid.body?.courses?.[1]?.total_lessons === 2)
  ok('nothing complete yet', grid.body?.courses?.every((c: any) => c.completed_lessons === 0))
  ok('resume points at lesson 1', grid.body?.courses?.every((c: any) => c.resume_lesson_number === 1))
  ok('cover_image_url present on the card payload', grid.body?.courses?.every((c: any) => 'cover_image_url' in c))

  console.log('\n-- per-course progress math is scoped, not global --')
  reset()
  progress = [{ user_id: MEMBER, lesson_id: 'a1', completed_at: NOW }]
  const g2 = await call(list)
  const a = g2.body.courses.find((c: any) => c.id === COURSE_A)
  const b = g2.body.courses.find((c: any) => c.id === COURSE_B)
  ok('course A shows 1 of 3', a.completed_lessons === 1 && a.total_lessons === 3)
  ok('course B still shows 0 of 2 — A progress does not leak', b.completed_lessons === 0 && b.total_lessons === 2)
  ok('course A resumes at lesson 2', a.resume_lesson_number === 2)
  ok('course B still resumes at lesson 1', b.resume_lesson_number === 1)

  console.log('\n-- SEQUENTIAL UNLOCK IS PER COURSE (the core regression risk) --')
  reset()
  // Nothing complete anywhere. Course B's lesson 2 must be locked by B's
  // lesson 1 — never satisfied by anything in course A.
  const bDetail = await call(detail, { query: { courseId: COURSE_B } })
  ok('course B lesson 1 active', bDetail.body?.lessons?.[0]?.status === 'active')
  ok('course B lesson 2 locked', bDetail.body?.lessons?.[1]?.status === 'locked')

  reset()
  progress = [{ user_id: MEMBER, lesson_id: 'a1', completed_at: NOW }] // completed A1 only
  const bAfterA1 = await call(detail, { query: { courseId: COURSE_B } })
  ok('completing course A lesson 1 does NOT unlock course B lesson 2', bAfterA1.body?.lessons?.[1]?.status === 'locked')
  const blocked = await call(complete, { method: 'POST', query: { courseId: COURSE_B, lessonNumber: 2 } })
  ok('and completing B2 is refused', blocked.status === 403 && blocked.body?.error === 'previous_lesson_incomplete')

  reset()
  progress = [{ user_id: MEMBER, lesson_id: 'b1', completed_at: NOW }] // completed B1
  const bAfterB1 = await call(detail, { query: { courseId: COURSE_B } })
  ok('completing B1 DOES unlock B2', bAfterB1.body?.lessons?.[1]?.status === 'active')
  const allowed = await call(complete, { method: 'POST', query: { courseId: COURSE_B, lessonNumber: 2 } })
  ok('and B2 completes', allowed.status === 200 && allowed.body?.success === true)
  ok('response carries updated per-course progress', allowed.body?.progress?.completed_lessons === 2 && allowed.body?.progress?.total_lessons === 2)

  console.log('\n-- completing is idempotent --')
  reset()
  await call(complete, { method: 'POST', query: { courseId: COURSE_A, lessonNumber: 1 } })
  const again = await call(complete, { method: 'POST', query: { courseId: COURSE_A, lessonNumber: 1 } })
  ok('second complete still 200s', again.status === 200)
  ok('no duplicate progress row', progress.filter((p) => p.lesson_id === 'a1').length === 1)

  console.log('\n-- a gap in lesson_number does not wall off the rest --')
  reset()
  // Admin deleted lesson 2; numbering is now 1, 3.
  lessons = [mkLesson('a1', COURSE_A, 1), mkLesson('a3', COURSE_A, 3)]
  progress = [{ user_id: MEMBER, lesson_id: 'a1', completed_at: NOW }]
  const gap = await call(complete, { method: 'POST', query: { courseId: COURSE_A, lessonNumber: 3 } })
  ok('lesson 3 completes after lesson 1 when 2 no longer exists', gap.status === 200, JSON.stringify(gap.body))

  console.log('\n-- lesson detail --')
  reset()
  const l1 = await call(lesson, { query: { courseId: COURSE_A, lessonNumber: 1 } })
  ok('200 with the lesson', l1.status === 200 && l1.body?.lesson?.lesson_number === 1)
  ok('course echoed back so the player can title itself', l1.body?.course?.title === 'The Micro Method')
  const l2 = await call(lesson, { query: { courseId: COURSE_A, lessonNumber: 2 } })
  ok('a locked lesson 403s', l2.status === 403 && l2.body?.error === 'lesson_locked')
  const l9 = await call(lesson, { query: { courseId: COURSE_A, lessonNumber: 9 } })
  ok('unknown lesson number 404s', l9.status === 404)
  const lBad = await call(lesson, { query: { courseId: 'not-a-uuid', lessonNumber: 1 } })
  ok('a non-uuid course id 400s rather than 500ing on PostgREST', lBad.status === 400)
  const lMissing = await call(detail, { query: { courseId: 'cccccccc-0000-4000-8000-00000000000c' } })
  ok('unknown course 404s', lMissing.status === 404)

  console.log('\n-- comments are scoped to (course, lesson), not lesson_number alone --')
  reset()
  await call(lessonComments, { method: 'POST', query: { courseId: COURSE_A, lessonNumber: 1 }, body: { content: 'from course A' } })
  await call(lessonComments, { method: 'POST', query: { courseId: COURSE_B, lessonNumber: 1 }, body: { content: 'from course B' } })
  const aComments = await call(lessonComments, { query: { courseId: COURSE_A, lessonNumber: 1 } })
  const bComments = await call(lessonComments, { query: { courseId: COURSE_B, lessonNumber: 1 } })
  ok('course A lesson 1 has only its own comment', aComments.body?.comments?.length === 1 && aComments.body.comments[0].content === 'from course A')
  ok('course B lesson 1 has only its own comment', bComments.body?.comments?.length === 1 && bComments.body.comments[0].content === 'from course B')
  const emptyComment = await call(lessonComments, { method: 'POST', query: { courseId: COURSE_A, lessonNumber: 1 }, body: { content: '  ' } })
  ok('empty comment 400s', emptyComment.status === 400)

  console.log('\n-- empty states --')
  reset()
  courses = []
  lessons = []
  const noCourses = await call(list)
  ok('zero courses returns [] not null', Array.isArray(noCourses.body?.courses) && noCourses.body.courses.length === 0)

  reset()
  courses = [mkCourse(COURSE_A, { title: 'Solo' })]
  lessons = []
  const oneEmpty = await call(list)
  ok('a course with no lessons still renders', oneEmpty.body?.courses?.length === 1)
  ok('total_lessons 0', oneEmpty.body.courses[0].total_lessons === 0)
  ok('resume_lesson_number null so the card has no broken link', oneEmpty.body.courses[0].resume_lesson_number === null)

  console.log('\n-- single course (the migrated Micro Method, pre-second-course) --')
  reset()
  courses = [mkCourse(COURSE_A, { title: 'The Micro Method' })]
  lessons = [mkLesson('a1', COURSE_A, 1), mkLesson('a2', COURSE_A, 2)]
  const solo = await call(list)
  ok('one card', solo.body?.courses?.length === 1 && solo.body.courses[0].total_lessons === 2)

  console.log('\n-- admin: course CRUD --')
  reset()
  const asMember = await call(adminList, { user: MEMBER })
  ok('a non-admin is blocked from the admin list', asMember.status === 403)
  const adminGrid = await call(adminList, { user: ADMIN })
  ok('admin sees both courses', adminGrid.body?.courses?.length === 2)
  ok('with lesson_count for the confirm dialog', adminGrid.body?.courses?.[0]?.lesson_count === 3)
  ok('and completion_count', adminGrid.body?.courses?.every((c: any) => c.completion_count === 0))

  const created = await call(adminList, { user: ADMIN, method: 'POST', body: { title: 'Brand New', description: 'desc', cover_image_url: 'https://x/y.png', sort_order: 9 } })
  ok('201 on create', created.status === 201, JSON.stringify(created.body))
  ok('course echoed with cover_image_url', created.body?.course?.cover_image_url === 'https://x/y.png')
  const noTitle = await call(adminList, { user: ADMIN, method: 'POST', body: { description: 'x' } })
  ok('create without a title 400s', noTitle.status === 400)

  const patched = await call(adminCourse, { user: ADMIN, method: 'PATCH', query: { courseId: COURSE_A }, body: { title: 'Renamed', sort_order: 5 } })
  ok('PATCH updates title + sort_order', patched.status === 200 && patched.body?.course?.title === 'Renamed')
  const badField = await call(adminCourse, { user: ADMIN, method: 'PATCH', query: { courseId: COURSE_A }, body: { id: 'nope' } })
  ok('unknown field 400s', badField.status === 400)
  const clearCover = await call(adminCourse, { user: ADMIN, method: 'PATCH', query: { courseId: COURSE_A }, body: { cover_image_url: '' } })
  ok('empty cover normalizes to null, not ""', clearCover.body?.course?.cover_image_url === null)

  console.log('\n-- admin: delete cascades, and reports what it destroyed --')
  reset()
  progress = [
    { user_id: MEMBER, lesson_id: 'a1', completed_at: NOW },
    { user_id: MEMBER, lesson_id: 'a2', completed_at: NOW },
    { user_id: MEMBER, lesson_id: 'b1', completed_at: NOW },
  ]
  comments = [{ id: 'c1', lesson_id: 'a1', content: 'hi', created_at: NOW, user: null }]
  const del = await call(adminCourse, { user: ADMIN, method: 'DELETE', query: { courseId: COURSE_A } })
  ok('200', del.status === 200)
  ok('reports 3 lessons removed', del.body?.deleted?.lessons === 3, JSON.stringify(del.body))
  ok('reports 2 member completions removed', del.body?.deleted?.completions === 2)
  ok('reports 1 comment removed', del.body?.deleted?.comments === 1)
  ok('course A gone', !courses.some((c) => c.id === COURSE_A))
  ok('its lessons cascaded', !lessons.some((l) => l.course_id === COURSE_A))
  ok("course B's progress survived — cascade did not over-reach", progress.some((p) => p.lesson_id === 'b1'))
  const delMissing = await call(adminCourse, { user: ADMIN, method: 'DELETE', query: { courseId: 'cccccccc-0000-4000-8000-00000000000c' } })
  ok('deleting an unknown course 404s', delMissing.status === 404)

  console.log('\n-- admin: lesson CRUD (surface that did not exist before) --')
  reset()
  const addedAuto = await call(adminLessons, { user: ADMIN, method: 'POST', query: { courseId: COURSE_A }, body: { title: 'Lesson 4' } })
  ok('201, appended', addedAuto.status === 201, JSON.stringify(addedAuto.body))
  ok('auto-assigned lesson_number 4', addedAuto.body?.lesson?.lesson_number === 4)
  ok('scoped to the right course', addedAuto.body?.lesson?.course_id === COURSE_A)

  const addedExplicit = await call(adminLessons, { user: ADMIN, method: 'POST', query: { courseId: COURSE_B }, body: { title: 'B7', lesson_number: 7, video_url: 'https://v', duration_minutes: 12 } })
  ok('explicit lesson_number honored', addedExplicit.body?.lesson?.lesson_number === 7)
  ok('video_url + duration stored', addedExplicit.body?.lesson?.video_url === 'https://v' && addedExplicit.body?.lesson?.duration_minutes === 12)

  const collide = await call(adminLessons, { user: ADMIN, method: 'POST', query: { courseId: COURSE_A }, body: { title: 'dup', lesson_number: 1 } })
  ok('a taken lesson_number is a 409, not a 500', collide.status === 409 && collide.body?.error === 'lesson_number_taken')

  const sameNumberOtherCourse = await call(adminLessons, { user: ADMIN, method: 'POST', query: { courseId: COURSE_B }, body: { title: 'B3', lesson_number: 3 } })
  ok('the SAME lesson_number in a different course is fine', sameNumberOtherCourse.status === 201)

  const patchedLesson = await call(adminLesson, { user: ADMIN, method: 'PATCH', query: { courseId: COURSE_A, lessonNumber: 1 }, body: { title: 'Edited', video_url: 'https://new' } })
  ok('PATCH edits the lesson', patchedLesson.status === 200 && patchedLesson.body?.lesson?.title === 'Edited')
  const renumberCollide = await call(adminLesson, { user: ADMIN, method: 'PATCH', query: { courseId: COURSE_A, lessonNumber: 1 }, body: { lesson_number: 2 } })
  ok('renumbering onto a taken slot 409s', renumberCollide.status === 409)
  const renumberOk = await call(adminLesson, { user: ADMIN, method: 'PATCH', query: { courseId: COURSE_A, lessonNumber: 1 }, body: { lesson_number: 8 } })
  ok('renumbering to a free slot works (reorder)', renumberOk.status === 200 && renumberOk.body?.lesson?.lesson_number === 8)

  reset()
  progress = [{ user_id: MEMBER, lesson_id: 'a2', completed_at: NOW }]
  const delLesson = await call(adminLesson, { user: ADMIN, method: 'DELETE', query: { courseId: COURSE_A, lessonNumber: 2 } })
  ok('DELETE lesson 200s', delLesson.status === 200)
  ok('reports the completion it cascaded', delLesson.body?.deleted?.completions === 1)
  ok('lesson gone', !lessons.some((l) => l.course_id === COURSE_A && l.lesson_number === 2))
  ok('remaining lessons NOT renumbered', lessons.filter((l) => l.course_id === COURSE_A).map((l) => l.lesson_number).join(',') === '1,3')
  const delLessonMissing = await call(adminLesson, { user: ADMIN, method: 'DELETE', query: { courseId: COURSE_A, lessonNumber: 99 } })
  ok('deleting an unknown lesson 404s', delLessonMissing.status === 404)

  console.log('\n-- admin gating on every admin route --')
  reset()
  ok('member blocked from course PATCH', (await call(adminCourse, { user: MEMBER, method: 'PATCH', query: { courseId: COURSE_A }, body: { title: 'x' } })).status === 403)
  ok('member blocked from course DELETE', (await call(adminCourse, { user: MEMBER, method: 'DELETE', query: { courseId: COURSE_A } })).status === 403)
  ok('member blocked from lesson create', (await call(adminLessons, { user: MEMBER, method: 'POST', query: { courseId: COURSE_A }, body: { title: 'x' } })).status === 403)
  ok('member blocked from lesson PATCH', (await call(adminLesson, { user: MEMBER, method: 'PATCH', query: { courseId: COURSE_A, lessonNumber: 1 }, body: { title: 'x' } })).status === 403)

  console.log('\n-- method guards --')
  reset()
  ok('POST on the courses list 405s', (await call(list, { method: 'POST' })).status === 405)
  ok('DELETE on course detail 405s', (await call(detail, { method: 'DELETE', query: { courseId: COURSE_A } })).status === 405)
  ok('POST on lesson detail 405s', (await call(lesson, { method: 'POST', query: { courseId: COURSE_A, lessonNumber: 1 } })).status === 405)
  ok('GET on complete 405s', (await call(complete, { method: 'GET', query: { courseId: COURSE_A, lessonNumber: 1 } })).status === 405)
  ok('DELETE on comments 405s', (await call(lessonComments, { method: 'DELETE', query: { courseId: COURSE_A, lessonNumber: 1 } })).status === 405)
  ok('GET on lesson create 405s', (await call(adminLessons, { user: ADMIN, method: 'GET', query: { courseId: COURSE_A } })).status === 405)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
