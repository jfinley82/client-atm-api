-- Add video_watched to users
alter table users add column if not exists video_watched boolean not null default false;

-- Add password_hash to users (for password-based auth)
alter table users add column if not exists password_hash text;

-- Forum tables
create table if not exists forum_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  slug text unique not null,
  sort_order integer default 0,
  created_at timestamptz not null default now()
);

create table if not exists forum_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  category_id uuid references forum_categories(id) on delete set null,
  title text not null,
  body text not null,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists forum_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references forum_posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists forum_likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references forum_posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

-- Seed default categories
insert into forum_categories (name, description, slug, sort_order) values
  ('Wins & Results', 'Share your progress and celebrate milestones', 'wins', 1),
  ('Ask the Community', 'Questions, feedback, and peer support', 'questions', 2),
  ('Offer Reviews', 'Share your offer for feedback from the group', 'offers', 3)
on conflict (slug) do nothing;

create index if not exists idx_forum_posts_user_id on forum_posts(user_id);
create index if not exists idx_forum_posts_category_id on forum_posts(category_id);
create index if not exists idx_forum_comments_post_id on forum_comments(post_id);
