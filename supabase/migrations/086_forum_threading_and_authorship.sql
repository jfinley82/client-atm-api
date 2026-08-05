-- Community board upgrade: threaded comments, author edit/delete, tombstones.

-- THREADING. null parent_id means top-level; a value means a reply to that
-- comment. Skool-style nesting rather than flat truncation.
--
-- ON DELETE CASCADE is the FK's behaviour, not the product's: the member DELETE
-- path deliberately never hard-deletes a comment that HAS replies (it tombstones
-- instead — see deleted_at), precisely so this cascade cannot take other
-- members' replies with it. The cascade remains as the backstop for the one case
-- where losing the branch is correct: deleting the whole post.
alter table forum_comments add column if not exists parent_id uuid references forum_comments(id) on delete cascade;
create index if not exists idx_forum_comments_parent on forum_comments (parent_id);
create index if not exists idx_forum_comments_post_created on forum_comments (post_id, created_at);

-- EDITED STAMP, its own column on BOTH tables.
--
-- Deliberately NOT forum_posts.updated_at: both api/forum/[postId]/comments.ts
-- and the admin comment delete write updated_at when they recompute
-- comment_count, so it already means "last activity on this thread". Using it as
-- the edited marker would flag a post as edited the moment anyone commented on
-- it. Null means never edited by its author.
alter table forum_posts add column if not exists edited_at timestamptz;
alter table forum_comments add column if not exists edited_at timestamptz;

-- TOMBSTONE. Set when a comment that has replies is deleted by its author or an
-- admin: the row survives so the branch beneath it survives, but the body and
-- the author are no longer served. A comment with NO replies is hard-deleted
-- instead, leaving nothing behind.
--
-- comment_count counts only rows where this is null — a tombstone is a
-- structural placeholder, not a comment anyone can read.
alter table forum_comments add column if not exists deleted_at timestamptz;

comment on column forum_comments.parent_id is
  'Null = top-level. Cascade is the FK backstop for post deletion; the member delete path tombstones a comment with replies rather than hard-deleting it, so replies are never collateral.';
comment on column forum_posts.edited_at is
  'Set ONLY when the author edits the body. Distinct from updated_at, which tracks thread activity (comment_count recomputes write it).';
comment on column forum_comments.edited_at is
  'Set ONLY when the author edits the body.';
comment on column forum_comments.deleted_at is
  'Tombstone: the comment had replies, so the row survives to hold the branch while body/author are withheld. Excluded from comment_count.';
