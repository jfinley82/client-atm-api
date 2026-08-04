-- Two more forum categories: Closing Clients (4) and Lead Generation (5).
--
-- Data, not structure — forum_categories already has every column these need.
-- Tracked as a numbered migration anyway, matching how data-only changes are
-- handled here (013 seeds course_lessons, 077 is a pure UPDATE), so the row
-- set has the same audit trail as the schema and scripts/migrate.mjs applies
-- it to every environment rather than it living only in whoever's psql history.
--
-- Purely additive: the original three (wins=1, questions=2, offers=3) are
-- untouched.
--
-- on conflict (slug) do nothing mirrors the original seed in
-- schema-update.sql. slug is unique, so re-running is a no-op rather than a
-- duplicate — which matters because the migration runner records a file as
-- applied only after it commits, so a retry after a mid-run failure must be
-- safe.
insert into forum_categories (name, description, slug, sort_order) values
  ('Closing Clients', 'Sales calls, objections, and closing more deals', 'closing', 4),
  ('Lead Generation', 'Traffic, ads, and generating more leads', 'leads', 5)
on conflict (slug) do nothing;
