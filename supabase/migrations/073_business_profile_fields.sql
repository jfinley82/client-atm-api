-- Business Profile tab: the six contact/profile fields the form has been
-- sending all along with nowhere to land. Their absence was not a cosmetic gap
-- — validateBusinessSettingsInput rejects the WHOLE request on the first key
-- missing from ALLOWED_KEYS, so a Save carrying business_address also took down
-- business_name, zoom_link, and the notification toggles riding the same PATCH.
--
-- All nullable free text, no backfill: an existing row simply has none of these
-- set until the coach saves the tab once.
alter table funnel_business_settings add column if not exists business_address text;
alter table funnel_business_settings add column if not exists phone text;
alter table funnel_business_settings add column if not exists email text;
alter table funnel_business_settings add column if not exists website text;
alter table funnel_business_settings add column if not exists industry text;
alter table funnel_business_settings add column if not exists years_in_business text;
