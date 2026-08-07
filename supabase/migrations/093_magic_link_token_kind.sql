-- 093_magic_link_token_kind.sql
--
-- Two token lifetimes, one redemption path.
--
-- A login link is short-lived on purpose: someone typing their email into a
-- login box is waiting, and a 15-minute window means a stolen inbox is only
-- briefly useful. An INVITE is the opposite shape — a workshop attendee opens
-- it hours later — so it needs days, not minutes.
--
-- Lengthening the existing expiry would weaken every login for the sake of one
-- flow. A separate table would fork api/auth/callback.ts, which is the
-- security-critical half: it holds the suspended-account check, the single-use
-- stamp and the session mint. Forking that to gain a column is the wrong trade.
--
-- So: one column, one table, one callback. The expiry becomes a property of the
-- row rather than of whichever code minted it.
--
-- Note this does not invent the 7-day lifetime — api/members/invite-beta.ts has
-- been minting 7-day tokens into this table since the beta invites shipped.
-- Those rows are indistinguishable from login tokens today. This names the
-- distinction that already exists.

alter table magic_link_tokens
  add column if not exists kind text not null default 'login';

-- text + CHECK rather than an enum: widening a CHECK is one migration, widening
-- an enum type is not.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'magic_link_tokens_kind_check'
  ) then
    alter table magic_link_tokens
      add constraint magic_link_tokens_kind_check
      check (kind in ('login', 'invite'));
  end if;
end $$;

-- Existing rows keep 'login' via the default. That is the honest label for
-- every row minted by send-magic-link and by the tier welcome email. The
-- invite-beta rows are mislabelled by this backfill and deliberately left
-- alone: they are all long expired, and rewriting history to match a
-- distinction that did not exist when they were written would be inventing a
-- fact. New invite-beta rows carry 'invite' from this commit forward.

comment on column magic_link_tokens.kind is
  'login = 15 minutes (lib/memberInvite.ts LOGIN_TTL_MS); invite = 7 days (INVITE_TTL_MS). Both single-use, both redeemed by api/auth/callback.ts.';
