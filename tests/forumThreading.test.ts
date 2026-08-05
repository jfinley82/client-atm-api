process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const AUTHOR = 'user-author'
const OTHER = 'user-other'
const ADMIN = 'user-admin'
const POST = 'post-1'
const OTHER_POST = 'post-2'

let users: Record<string, any> = {}
let posts: any[] = []
let comments: any[] = []

function eqParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
const isParam = (url: string, key: string) => new RegExp(`[?&]${key}=is\\.null`).test(url)

// Recursive delete, exactly as the FK's ON DELETE CASCADE behaves — verified
// against production, where deleting a root took its child AND grandchild.
function cascadeDelete(id: string) {
  const kids = comments.filter((c) => c.parent_id === id).map((c) => c.id)
  comments = comments.filter((c) => c.id !== id)
  for (const k of kids) cascadeDelete(k)
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
  const isHead = (init?.method || '').toUpperCase() === 'HEAD' || /count=exact/.test(String(init?.headers?.Prefer || init?.headers?.prefer || ''))

  if (url.includes('/rest/v1/users')) return json(users[eqParam(url, 'id') || ''] ?? null)

  if (url.includes('/rest/v1/forum_posts')) {
    const id = eqParam(url, 'id')
    if (method === 'PATCH') {
      const row = posts.find((p) => p.id === id)
      if (row) Object.assign(row, body)
      return json(row ?? null)
    }
    if (method === 'DELETE') {
      const row = posts.find((p) => p.id === id)
      posts = posts.filter((p) => p.id !== id)
      // post_id is ON DELETE CASCADE — the thread goes with the post.
      if (row) comments = comments.filter((c) => c.post_id !== id)
      return json(row ?? null)
    }
    return json(posts.find((p) => p.id === id) ?? null)
  }

  if (url.includes('/rest/v1/forum_comments')) {
    const id = eqParam(url, 'id')
    const postId = eqParam(url, 'post_id')
    const parentId = eqParam(url, 'parent_id')

    if (method === 'POST') {
      const row = { id: `c-${comments.length + 1}`, created_at: new Date(2026, 7, 5, 12, 0, comments.length).toISOString(), edited_at: null, deleted_at: null, parent_id: null, ...body }
      comments.push(row)
      return json(row, 201)
    }
    if (method === 'PATCH') {
      const row = comments.find((c) => c.id === id)
      if (row) Object.assign(row, body)
      return json(row ?? null)
    }
    if (method === 'DELETE') {
      const row = comments.find((c) => c.id === id)
      if (row) cascadeDelete(id)
      return json(row ?? null)
    }

    // count=exact&head — used by the comment_count recompute and the reply probe
    let rows = comments.slice()
    if (postId) rows = rows.filter((c) => c.post_id === postId)
    if (parentId) rows = rows.filter((c) => c.parent_id === parentId)
    if (isParam(url, 'deleted_at')) rows = rows.filter((c) => !c.deleted_at)
    if (id) rows = rows.filter((c) => c.id === id)

    if (isHead) {
      return new Response(null, {
        status: 200,
        headers: { 'Content-Range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` },
      })
    }
    rows = rows.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    const withUser = rows.map((c) => ({ ...c, user: users[c.user_id] ? { id: c.user_id, name: users[c.user_id].name } : null }))
    if (id) return json(withUser[0] ?? null)
    return json(withUser)
  }
  return json([])
}) as typeof fetch

function reset() {
  users = {
    [AUTHOR]: { id: AUTHOR, name: 'Author', role: 'member', status: 'active' },
    [OTHER]: { id: OTHER, name: 'Other', role: 'member', status: 'active' },
    [ADMIN]: { id: ADMIN, name: 'Admin', role: 'admin', status: 'active' },
  }
  posts = [
    { id: POST, user_id: AUTHOR, title: 'T', body: 'B', comment_count: 0, updated_at: '2026-08-01T00:00:00Z', edited_at: null },
    { id: OTHER_POST, user_id: OTHER, title: 'T2', body: 'B2', comment_count: 0, updated_at: '2026-08-01T00:00:00Z', edited_at: null },
  ]
  comments = []
}

async function call(handler: Handler, userId: string | null, opts: { method?: string; query?: any; body?: any } = {}) {
  let status = 0, resBody: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { resBody = v; return res }, end() { return res } }
  const req: any = { method: opts.method || 'GET', headers: {}, body: opts.body, query: opts.query || {} }
  if (userId) req.headers.authorization = `Bearer ${await createSessionToken(userId)}`
  await handler(req, res)
  return { status, body: resBody }
}

const freshCount = (postId: string) => comments.filter((c) => c.post_id === postId && !c.deleted_at).length

;(async () => {
  const commentsHandler: Handler = (await import('../api/forum/[postId]/comments')).default
  const postHandler: Handler = (await import('../api/forum/posts/[id]')).default
  const commentHandler: Handler = (await import('../api/forum/comments/[id]')).default
  const adminCommentHandler: Handler = (await import('../api/admin/forum/comments/[id]')).default

  const addComment = async (userId: string, body: string, parent_id?: string) =>
    (await call(commentsHandler, userId, { method: 'POST', query: { postId: POST }, body: { body, ...(parent_id ? { parent_id } : {}) } })).body?.comment

  console.log('\n-- a reply to a reply persists and comes back NESTED --')
  {
    reset()
    const a = await addComment(AUTHOR, 'top level')
    const b = await addComment(OTHER, 'reply', a.id)
    const c = await addComment(AUTHOR, 'reply to the reply', b.id)
    ok('the reply stored its parent', b.parent_id === a.id, JSON.stringify(b))
    ok('and the reply-to-reply stored its own', c.parent_id === b.id)

    const tree = (await call(commentsHandler, null, { query: { postId: POST } })).body?.comments
    ok('one root', tree.length === 1, JSON.stringify(tree.map((n: any) => n.id)))
    ok('with one reply nested under it', tree[0].replies.length === 1)
    ok('and the third nested TWO deep', tree[0].replies[0].replies.length === 1, JSON.stringify(tree, null, 0).slice(0, 200))
    ok('depth-3 body survives', tree[0].replies[0].replies[0].body === 'reply to the reply')
    ok('authors ride along at depth', tree[0].replies[0].user?.name === 'Other')
  }
  {
    // A reply cannot be grafted onto another thread's comment.
    reset()
    const foreign = { id: 'c-foreign', post_id: OTHER_POST, user_id: OTHER, body: 'elsewhere', parent_id: null, created_at: '2026-08-01T00:00:00Z', deleted_at: null }
    comments.push(foreign)
    const r = await call(commentsHandler, AUTHOR, { method: 'POST', query: { postId: POST }, body: { body: 'graft', parent_id: 'c-foreign' } })
    ok('a cross-thread parent is rejected', r.status === 400 && r.body?.error === 'parent_not_in_thread', JSON.stringify(r.body))
    ok('and nothing was written', comments.filter((c) => c.post_id === POST).length === 0)
  }

  console.log('\n-- deleting a comment WITH replies tombstones it and keeps the branch --')
  {
    reset()
    const a = await addComment(AUTHOR, 'parent')
    const b = await addComment(OTHER, 'child', a.id)
    await addComment(OTHER, 'grandchild', b.id)
    ok('three comments to start', freshCount(POST) === 3)

    const del = await call(commentHandler, AUTHOR, { method: 'DELETE', query: { id: a.id } })
    ok('delete succeeds', del.status === 200, JSON.stringify(del.body))
    ok('and reports it tombstoned', del.body?.tombstoned === true, JSON.stringify(del.body))
    ok('the row survives to hold the branch', comments.some((c) => c.id === a.id))
    ok('the child survived', comments.some((c) => c.id === b.id), 'cascade took the branch — the whole point of tombstoning')
    ok('the grandchild survived too', comments.length === 3)

    const tree = (await call(commentsHandler, null, { query: { postId: POST } })).body?.comments
    ok('the tombstone is still the root of the tree', tree.length === 1 && tree[0].id === a.id)
    ok('marked deleted', tree[0].deleted === true)
    ok('body withheld', tree[0].body === null, JSON.stringify(tree[0]))
    ok('author withheld', tree[0].user === null)
    ok('but its replies are still readable', tree[0].replies[0].body === 'child')

    ok('comment_count excludes the tombstone', posts[0].comment_count === 2, `${posts[0].comment_count}`)
    ok('and matches a fresh count', posts[0].comment_count === freshCount(POST), `${posts[0].comment_count} vs ${freshCount(POST)}`)
  }

  console.log('\n-- deleting a LEAF comment removes it entirely, no tombstone litter --')
  {
    reset()
    const a = await addComment(AUTHOR, 'parent')
    const b = await addComment(AUTHOR, 'leaf', a.id)
    const del = await call(commentHandler, AUTHOR, { method: 'DELETE', query: { id: b.id } })
    ok('reports a hard delete', del.body?.tombstoned === false, JSON.stringify(del.body))
    ok('the row is gone', !comments.some((c) => c.id === b.id))
    const tree = (await call(commentsHandler, null, { query: { postId: POST } })).body?.comments
    ok('no placeholder left in the tree', tree[0].replies.length === 0, JSON.stringify(tree))
    ok('comment_count matches a fresh count', posts[0].comment_count === freshCount(POST), `${posts[0].comment_count} vs ${freshCount(POST)}`)
  }

  console.log('\n-- the admin delete behaves the SAME, so moderation cannot destroy a branch --')
  {
    reset()
    const a = await addComment(AUTHOR, 'parent')
    await addComment(OTHER, 'child', a.id)
    const del = await call(adminCommentHandler, ADMIN, { method: 'DELETE', query: { id: a.id } })
    ok('admin delete succeeds', del.status === 200, JSON.stringify(del.body))
    ok('and tombstones rather than cascading', del.body?.tombstoned === true)
    ok('the child survived an admin delete', comments.length === 2, JSON.stringify(comments.map((c) => c.id)))
    ok('comment_count matches a fresh count', posts[0].comment_count === freshCount(POST), `${posts[0].comment_count}`)
  }

  console.log('\n-- deleting the POST takes the whole thread, which IS correct there --')
  {
    reset()
    const a = await addComment(AUTHOR, 'parent')
    await addComment(OTHER, 'child', a.id)
    const del = await call(postHandler, AUTHOR, { method: 'DELETE', query: { id: POST } })
    ok('post delete succeeds', del.status === 200, JSON.stringify(del.body))
    ok('the thread went with it', comments.filter((c) => c.post_id === POST).length === 0)
  }

  console.log('\n-- author can edit and delete their own; nobody else can --')
  {
    reset()
    const mine = await addComment(AUTHOR, 'mine')
    const theirs = await addComment(OTHER, 'theirs')

    const editMine = await call(commentHandler, AUTHOR, { method: 'PATCH', query: { id: mine.id }, body: { body: 'fixed my typo' } })
    ok('author edits their own comment', editMine.status === 200 && editMine.body?.comment?.body === 'fixed my typo', JSON.stringify(editMine.body))

    const editTheirs = await call(commentHandler, AUTHOR, { method: 'PATCH', query: { id: theirs.id }, body: { body: 'not mine' } })
    ok("author cannot edit someone else's comment", editTheirs.status === 403, `${editTheirs.status}`)
    ok('and the body is untouched', comments.find((c) => c.id === theirs.id)?.body === 'theirs')

    const delTheirs = await call(commentHandler, AUTHOR, { method: 'DELETE', query: { id: theirs.id } })
    ok("author cannot delete someone else's comment", delTheirs.status === 403)

    const adminEdit = await call(commentHandler, ADMIN, { method: 'PATCH', query: { id: theirs.id }, body: { body: 'moderated' } })
    ok('an admin can', adminEdit.status === 200, `${adminEdit.status}`)

    const anon = await call(commentHandler, null, { method: 'DELETE', query: { id: mine.id } })
    ok('an unauthenticated caller cannot', anon.status === 401, `${anon.status}`)

    const missing = await call(commentHandler, AUTHOR, { method: 'DELETE', query: { id: 'c-nope' } })
    ok('a missing comment is 404, not 403', missing.status === 404, `${missing.status}`)
  }
  {
    reset()
    const editMine = await call(postHandler, AUTHOR, { method: 'PATCH', query: { id: POST }, body: { title: 'New title' } })
    ok('author edits their own post', editMine.status === 200 && editMine.body?.post?.title === 'New title', JSON.stringify(editMine.body))
    const editTheirs = await call(postHandler, AUTHOR, { method: 'PATCH', query: { id: OTHER_POST }, body: { title: 'nope' } })
    ok("author cannot edit someone else's post", editTheirs.status === 403)
    const delTheirs = await call(postHandler, AUTHOR, { method: 'DELETE', query: { id: OTHER_POST } })
    ok("nor delete it", delTheirs.status === 403)
    ok('and it still exists', posts.some((p) => p.id === OTHER_POST))
  }

  console.log('\n-- edited_at sets on an author edit and NOT when someone merely comments --')
  {
    reset()
    ok('starts null', posts[0].edited_at === null)

    // Someone comments: comment_count recompute writes updated_at...
    await addComment(OTHER, 'just commenting')
    ok('a comment does NOT set edited_at', posts[0].edited_at === null, JSON.stringify(posts[0].edited_at))
    ok('but it DOES move updated_at', posts[0].updated_at !== '2026-08-01T00:00:00Z', posts[0].updated_at)

    // ...whereas an author edit sets edited_at.
    await call(postHandler, AUTHOR, { method: 'PATCH', query: { id: POST }, body: { body: 'reworded' } })
    ok('an author edit sets edited_at', typeof posts[0].edited_at === 'string', JSON.stringify(posts[0].edited_at))
  }
  {
    reset()
    const c = await addComment(AUTHOR, 'original')
    ok('comment edited_at starts null', comments.find((x) => x.id === c.id)?.edited_at === null)
    await call(commentHandler, AUTHOR, { method: 'PATCH', query: { id: c.id }, body: { body: 'reworded' } })
    ok('and sets on edit', typeof comments.find((x) => x.id === c.id)?.edited_at === 'string')
  }
  {
    // A tombstone must not be editable back into existence.
    reset()
    const a = await addComment(AUTHOR, 'parent')
    await addComment(OTHER, 'child', a.id)
    await call(commentHandler, AUTHOR, { method: 'DELETE', query: { id: a.id } })
    const r = await call(commentHandler, AUTHOR, { method: 'PATCH', query: { id: a.id }, body: { body: 'undelete me' } })
    ok('editing a tombstone is refused', r.status === 409 && r.body?.error === 'comment_deleted', `${r.status} ${JSON.stringify(r.body)}`)
  }

  console.log('\n-- method guards --')
  {
    reset()
    ok('POST on the post detail 405s', (await call(postHandler, AUTHOR, { method: 'POST', query: { id: POST } })).status === 405)
    ok('GET on the comment detail 405s', (await call(commentHandler, AUTHOR, { method: 'GET', query: { id: 'c-1' } })).status === 405)
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
