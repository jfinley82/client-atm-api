-- Editable privacy / terms served on the funnel's own domain.
--
-- funnel_business_settings.legal already holds privacy_url / terms_url — LINKS to
-- pages the coach hosts somewhere else. A coach running paid traffic needs those
-- pages to exist, and most have nowhere to put them, so the links are commonly
-- empty and the footer renders without them. These two columns let the coach
-- write the content here and have {subdomain}.freeminiworkshop.com/privacy and
-- /terms serve it.
--
-- Plain text, not HTML: it is rendered escaped, paragraph by paragraph. Accepting
-- HTML would make an owner-writable field a stored-XSS vector on a public page.
alter table funnels add column if not exists legal_privacy text;
alter table funnels add column if not exists legal_terms text;

comment on column funnels.legal_privacy is
  'Plain-text privacy policy served at /privacy on the funnel domain. NULL falls back to the account-level privacy_url link.';
comment on column funnels.legal_terms is
  'Plain-text terms served at /terms on the funnel domain. NULL falls back to the account-level terms_url link.';
