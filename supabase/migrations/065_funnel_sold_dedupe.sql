-- One sale per attribution token.
--
-- The conversion pixel is an <img> on the coach's own thank-you page, and a
-- buyer refreshes, bookmarks, and revisits that page. Without this the same
-- purchase would post a 'sold' event — and therefore revenue — on every load.
--
-- A unique index rather than a read-then-write check in the endpoint: two
-- simultaneous loads would both read "not recorded" and both insert. The index
-- makes the second one a 23505, which the endpoint already treats as the
-- expected benign outcome.
--
-- Partial + NULL-guarded, matching the shape of the email-open dedup index in
-- 048: only 'sold' rows carrying a ref participate, so every other event type is
-- unaffected and a manually-recorded sale with no ref is still allowed.
create unique index if not exists uq_funnel_events_sold_ref
  on funnel_events (funnel_id, (metadata->>'ref'))
  where event_type = 'sold' and metadata->>'ref' is not null;
