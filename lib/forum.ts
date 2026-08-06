import { supabase } from './supabase'

// Shared forum authorship + comment-tree logic, in one place so the member and
// admin paths cannot drift into different rules.
//
// NOTE ON "reuse the ownership check": there wasn't one. api/admin/forum/
// posts/[id] and api/admin/forum/comments/[id] both gate on role === 'admin',
// which is an ADMIN check, not an authorship check — under it a member cannot
// touch their own typo. This module is that missing check, written once and
// used by every path that mutates a post or comment.

export type Authz = { ok: true; isAdmin: boolean } | { ok: false; status: number; error: string }

/**
 * Author-or-admin. One round trip for the role, one for the row's owner.
 *
 * 404 for a missing row and 403 for someone else's is deliberate: a member
 * probing ids learns whether a post exists either way (the feed is public), so
 * there is nothing to conceal by flattening them, and a distinct 403 is what
 * lets the frontend say "not yours" rather than "gone".
 *
 * THE ONE PATH NOTHING HERE COVERS: a real member being refused on another
 * member's content. tests/forumThreading.test.ts exercises this branch, but
 * handler-level against a mocked database — it proves the logic below, not that
 * production refuses. And production could not be checked, for two separate
 * reasons that both have to clear before it can be:
 *
 *   1. A signed-in session for a non-admin member. Non-admin ACCOUNTS already
 *      exist (a full-tier member and a low_ticket member, both role: 'user'), so
 *      "an account appears" is not the trigger — the account is not the missing
 *      piece, a session for one is, and nobody can produce that without entering
 *      someone else's credentials. Jamaul is admin, so his token passes every
 *      check and proves nothing about this branch.
 *   2. Content belonging to a second member to attempt against. Neither of those
 *      accounts has ever posted or commented, so even with a session there would
 *      be nothing of theirs to try to edit.
 *
 * So the trigger to watch for is narrower than a new account: a second member
 * signed in AND having posted. When that happens naturally, one edit or delete
 * attempt against their comment from another member's session closes this in ten
 * seconds. Whoever is there when the conditions line up: take the shot.
 */
export async function authorizeOwnerOrAdmin(
  table: 'forum_posts' | 'forum_comments',
  rowId: string,
  userId: string
): Promise<Authz> {
  const [{ data: actingUser }, { data: row }] = await Promise.all([
    supabase.from('users').select('role').eq('id', userId).maybeSingle(),
    supabase.from(table).select('user_id').eq('id', rowId).maybeSingle(),
  ])

  if (!row) return { ok: false, status: 404, error: 'not_found' }
  const isAdmin = actingUser?.role === 'admin'
  if (!isAdmin && (row as { user_id: string }).user_id !== userId) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true, isAdmin }
}

/**
 * Recompute forum_posts.comment_count from the comments themselves.
 *
 * Kept as a recompute rather than an increment/decrement because a recompute
 * cannot drift — the existing endpoints already do this and it is the right
 * pattern. Call it AFTER any delete so it counts what actually survived a
 * cascade, never what was expected to.
 *
 * Tombstones are excluded: a deleted-with-replies row still exists to hold its
 * branch, but it is not a comment anyone can read, so counting it would
 * overstate the thread.
 */
export async function recomputeCommentCount(postId: string): Promise<void> {
  const { count } = await supabase
    .from('forum_comments')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', postId)
    .is('deleted_at', null)

  await supabase
    .from('forum_posts')
    .update({ comment_count: count ?? 0, updated_at: new Date().toISOString() })
    .eq('id', postId)
}

export type CommentDeletion = { postId: string; tombstoned: boolean }

/**
 * Delete one comment, choosing HARD DELETE or TOMBSTONE by whether anything is
 * replying to it.
 *
 * THE DECISION, stated rather than assumed: a comment with replies is
 * TOMBSTONED — the row survives, its body and author stop being served, and the
 * branch beneath it stays readable. A comment with no replies is hard-deleted
 * and leaves nothing behind.
 *
 * Why not cascade: parent_id is ON DELETE CASCADE and it is recursive — verified
 * against production, deleting a root took its child AND grandchild. So a
 * cascade here would let one member's delete destroy other members' replies,
 * which is content they wrote and the deleter has no claim over. Losing your own
 * comment is the deleter's choice; losing the three replies under it is not
 * theirs to make.
 *
 * Why not tombstone everything: a leaf tombstone is litter. It holds no branch,
 * so it exists only to show "[deleted]" forever in a thread nobody was reading.
 */
export async function deleteCommentCascadeAware(commentId: string): Promise<CommentDeletion | null> {
  const { data: target } = await supabase
    .from('forum_comments')
    .select('id, post_id, deleted_at')
    .eq('id', commentId)
    .maybeSingle()
  if (!target) return null

  const postId = (target as { post_id: string }).post_id

  const { count: replyCount } = await supabase
    .from('forum_comments')
    .select('id', { count: 'exact', head: true })
    .eq('parent_id', commentId)

  if ((replyCount ?? 0) > 0) {
    await supabase
      .from('forum_comments')
      .update({ deleted_at: new Date().toISOString(), body: '' })
      .eq('id', commentId)
    await recomputeCommentCount(postId)
    return { postId, tombstoned: true }
  }

  await supabase.from('forum_comments').delete().eq('id', commentId)
  await recomputeCommentCount(postId)
  return { postId, tombstoned: false }
}

// One comment as the tree serves it. A tombstone keeps its id, timestamps and
// children, and loses everything identifying.
export type CommentNode = {
  id: string
  body: string | null
  created_at: string
  edited_at: string | null
  parent_id: string | null
  deleted: boolean
  user: { id: string; name: string } | null
  replies: CommentNode[]
}

type CommentRow = {
  id: string
  body: string
  created_at: string
  edited_at: string | null
  parent_id: string | null
  deleted_at: string | null
  user?: { id: string; name: string } | null
}

/**
 * Flat rows (oldest first) -> nested tree, oldest first at every level.
 *
 * Single pass, so it is linear rather than quadratic on a long thread. A row
 * whose parent_id points at something not in this set is treated as top-level
 * rather than dropped — orphaning a comment out of the response would hide a
 * member's words because of a data problem they did not cause.
 */
export function buildCommentTree(rows: CommentRow[]): CommentNode[] {
  const byId = new Map<string, CommentNode>()
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      // Tombstone: withhold body and author, keep the shape.
      body: r.deleted_at ? null : r.body,
      created_at: r.created_at,
      edited_at: r.deleted_at ? null : r.edited_at,
      parent_id: r.parent_id,
      deleted: !!r.deleted_at,
      user: r.deleted_at ? null : r.user ?? null,
      replies: [],
    })
  }

  const roots: CommentNode[] = []
  for (const r of rows) {
    const node = byId.get(r.id)!
    const parent = r.parent_id ? byId.get(r.parent_id) : undefined
    if (parent) parent.replies.push(node)
    else roots.push(node)
  }
  return roots
}
