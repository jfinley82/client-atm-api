-- The coach's own public booking page: its address, and the copy on it.
--
-- WHY THESE LIVE ON funnel_business_settings rather than users. This is
-- account-level coach configuration reused across everything they publish,
-- which is what that table already is. users is the account record and is read
-- by auth on every request.
--
-- booking_slug is the first PUBLIC IDENTIFIER a coach has ever had. Funnels have
-- subdomain; coaches had nothing, which is why this page could not exist. It is
-- deliberately not the user's uuid: a link a coach pastes into an email should
-- be something they would be happy to say out loud.
--
-- The unique index is partial on NOT NULL, so every coach who has not set one
-- stays null without colliding with every other coach who has not set one.
-- Lowercase is enforced in the application (normalizeBookingSlug) and the index
-- is on the raw column, so two slugs differing only in case cannot both exist —
-- the application never writes a non-lowercase value.
--
-- Title and description are per PAGE, not per funnel: this page outlives any one
-- funnel, so it cannot borrow that funnel's offer copy. Both optional, with
-- fallbacks applied at read time rather than stored, so changing the fallback
-- later reprices every page instead of leaving rows stamped with the old one.

alter table funnel_business_settings
  add column if not exists booking_slug text,
  add column if not exists booking_page_title text,
  add column if not exists booking_page_description text;

create unique index if not exists funnel_business_settings_booking_slug_key
  on funnel_business_settings (booking_slug)
  where booking_slug is not null;

comment on column funnel_business_settings.booking_slug is
  'The coach''s public booking page address: /{slug}. Unique, lowercase, [a-z0-9-]. NULL until the coach chooses one - the page does not exist without it.';
comment on column funnel_business_settings.booking_page_title is
  'Heading on the public booking page. NULL falls back to "Book a call" at read time.';
comment on column funnel_business_settings.booking_page_description is
  'Optional paragraph under the title. NULL renders nothing.';
