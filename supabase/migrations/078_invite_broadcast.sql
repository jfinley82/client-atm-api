-- Invite broadcast: the coach's own list, imported once and mailed once per
-- funnel, on top of the existing funnel_email_sends + Resend stack.
--
-- Deliberately NOT funnel_leads. An imported contact never visited the funnel
-- and never opted in, so writing them as leads would inflate visits, opt-in
-- rate and every rollup built on them. Contacts are account-level and live in
-- their own table; their sends join back through funnel_email_sends.contact_id.

-- ── the coach's list ─────────────────────────────────────────────────────────
create table if not exists public.coach_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- Always stored lowercase; see the unique index below.
  email text not null,
  first_name text,
  -- Which upload this row came from, so the Emails tab can name the last import.
  source_filename text,
  -- Set from the unsubscribe link in an invite; suppresses every future send.
  unsubscribed boolean not null default false,
  created_at timestamptz not null default now()
);

-- One row per address per coach. Case-insensitivity is enforced on WRITE —
-- lib/coachContacts.ts lowercases every parsed address — rather than by a
-- lower(email) expression index, because ON CONFLICT (user_id, email) cannot
-- use an expression index: the upsert would fail with "no unique or exclusion
-- constraint matching the ON CONFLICT specification". Same guarantee (Sam@x.com
-- and sam@x.com are one row), and an upsert that actually works.
create unique index if not exists idx_coach_contacts_user_email
  on public.coach_contacts (user_id, email);

-- The import and the broadcast both scan by owner.
create index if not exists idx_coach_contacts_user on public.coach_contacts (user_id, created_at desc);

comment on table public.coach_contacts is
  'A coach''s own email list, imported by CSV. Account-level, NOT funnel leads: an imported contact never visited a funnel, so counting them as leads would corrupt visit/opt-in analytics.';

-- ── per-funnel invite copy ───────────────────────────────────────────────────
-- Seeded at funnel creation from mtm_generations.warm_invite_emails and edited
-- through PATCH /api/funnels/[id], exactly like nurture_emails.
alter table public.funnels
  add column if not exists warm_invite_emails jsonb;

comment on column public.funnels.warm_invite_emails is
  'This funnel''s warm-invite sequence, seeded from the coach''s build and editable. Same {subject, body, send_timing, email_number} shape as nurture_emails.';

-- ── send attribution ─────────────────────────────────────────────────────────
-- Nullable: every existing row is lead-scoped and stays that way. Only invite_*
-- sends carry a contact instead.
alter table public.funnel_email_sends
  add column if not exists contact_id uuid references public.coach_contacts(id) on delete set null;

create index if not exists idx_funnel_email_sends_contact
  on public.funnel_email_sends (contact_id);

comment on column public.funnel_email_sends.contact_id is
  'Set only on invite_* sends, which go to a coach_contacts row rather than a funnel lead. lead_id is null on exactly those rows.';

-- ── one broadcast per funnel ─────────────────────────────────────────────────
-- The row IS the idempotency guard: unique on funnel_id, so a second click
-- conflicts instead of enrolling the list twice.
create table if not exists public.funnel_invite_broadcasts (
  id uuid primary key default gen_random_uuid(),
  funnel_id uuid not null references public.funnels(id) on delete cascade,
  -- The coach's explicit "these people asked to hear from me" confirmation.
  -- Recorded, not just checked, because it is the consent record.
  consent_confirmed boolean not null default false,
  contact_count integer not null default 0,
  status text not null default 'sent',
  created_at timestamptz not null default now()
);

create unique index if not exists idx_funnel_invite_broadcasts_funnel
  on public.funnel_invite_broadcasts (funnel_id);

comment on table public.funnel_invite_broadcasts is
  'One row per funnel that has broadcast its warm invites. The unique index on funnel_id is what makes the send idempotent — a repeat click conflicts rather than mailing the list again.';
