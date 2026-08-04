-- Training: generalize the single fixed course into a course library.
--
-- Migration 013 modelled exactly one course: course_lessons was a flat table
-- with UNIQUE(lesson_number), which only works while there is one course to
-- number lessons within. This introduces `courses` and re-scopes that
-- uniqueness per course.
--
-- The existing 7 lessons are migrated IN PLACE onto a new "The Micro Method"
-- course row — not copied. lesson_progress and lesson_comments both key off
-- course_lessons.id, and no lesson id changes here, so every completion and
-- comment survives untouched without needing a data migration of its own.
-- (Production currently has 0 of each, but the design does not depend on that.)

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  -- Plain admin-settable URL, same pattern as users.logo_url / headshot_url.
  -- Deliberately no upload pipeline: the images are supplied externally.
  cover_image_url text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_courses_sort_order on courses (sort_order);

alter table course_lessons add column if not exists course_id uuid references courses(id) on delete cascade;

-- Seed the course the existing lessons belong to, then adopt them.
--
-- Guarded so re-running is a no-op rather than creating a second Micro Method
-- and orphaning the first: courses has no natural unique key to hang an
-- ON CONFLICT off (title is not unique, and shouldn't be — two courses may
-- legitimately share a name), so the guard is "only if nothing owns these
-- lessons yet".
insert into courses (title, description, sort_order)
select
  'The Micro Method',
  'The full Micro-Training Method, start to finish.',
  1
where exists (select 1 from course_lessons where course_id is null)
  and not exists (select 1 from course_lessons where course_id is not null);

update course_lessons
   set course_id = (select id from courses order by sort_order, created_at limit 1)
 where course_id is null;

-- Uniqueness moves from global to per-course. Done AFTER the backfill so the
-- new constraint is validated against rows that already have a course_id;
-- doing it first would compare (null, 1)…(null, 7) — which passes, since
-- Postgres treats nulls as distinct in a unique constraint, and would leave
-- the real duplicate check unperformed.
alter table course_lessons drop constraint if exists course_lessons_lesson_number_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'course_lessons'::regclass
       and conname = 'course_lessons_course_id_lesson_number_key'
  ) then
    alter table course_lessons
      add constraint course_lessons_course_id_lesson_number_key unique (course_id, lesson_number);
  end if;
end $$;

-- Only safe once every row is backfilled. A lesson with no course is
-- unreachable through the API (every read is course-scoped), so allowing one
-- would just be a silent way to lose content.
alter table course_lessons alter column course_id set not null;

create index if not exists idx_course_lessons_course_id on course_lessons (course_id);
