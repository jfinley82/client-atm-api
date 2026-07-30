-- Drop the per-funnel branding/legal columns made dead by #109: branding and
-- legal are business-global (funnel_business_settings, keyed on user_id), and
-- the public renderer (api/funnels/render.ts) has not selected or read any of
-- these since that change. api/funnels/[id]/settings.ts and
-- api/funnels/[id]/index.ts have been updated in the same change as this
-- migration to stop writing them (silently stripped from the request body
-- rather than rejected, so a stale caller still saves everything else).
--
-- Confirmed via a full grep of api/ and lib/ immediately before writing this
-- migration: no remaining reader or writer of any of these nine columns.
alter table funnels drop column if exists brand_font;
alter table funnels drop column if exists brand_headline_font;
alter table funnels drop column if exists brand_body_font;
alter table funnels drop column if exists brand_primary_color;
alter table funnels drop column if exists brand_secondary_color;
alter table funnels drop column if exists logo_url;
alter table funnels drop column if exists headshot_url;
alter table funnels drop column if exists legal_privacy;
alter table funnels drop column if exists legal_terms;
