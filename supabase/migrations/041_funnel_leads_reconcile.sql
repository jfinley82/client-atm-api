-- Reconcile funnel_leads with the columns Phase 1 expects.
--
-- DB drift: funnel_leads (and funnel_events) already existed in the production
-- database from earlier funnel work that never landed in the repo migrations
-- (only 012 and 040 reference funnels). Migration 040's
-- `create table if not exists funnel_leads (...)` was therefore a SILENT NO-OP
-- against a pre-existing table with a divergent schema, so the columns Phase 1's
-- lead endpoint writes (first_name, opted_in_at, problem_solution_snapshot,
-- close_amount, source, ip) did not exist and POST /api/funnel/lead 500'd.
-- (funnel_events happened to already match — its columns and the event_type
-- CHECK cover all five event names — so it needed no reconcile.)
--
-- This ALTERs the real table into the shape the code expects. Idempotent
-- (ADD COLUMN IF NOT EXISTS), so it is a no-op on any database where migration
-- 040 already created the table with these columns.
--
-- NOTE for later phases: the live funnel_leads.status set is
-- lead/watching/booked/showed/no_show/sold (NO 'closed'). We only realign the
-- DEFAULT to 'lead' here and deliberately leave the CHECK constraint alone.
-- Phase 2's manual close/amount flow must reconcile to that existing set (or add
-- 'closed') rather than assume the lead/booked/closed set migration 040 wrote
-- into its never-applied CREATE. Future funnel migrations should ALTER/verify
-- against the real schema, not assume greenfield.

alter table funnel_leads add column if not exists first_name text;
alter table funnel_leads add column if not exists opted_in_at timestamptz default now();
alter table funnel_leads add column if not exists problem_solution_snapshot jsonb;
alter table funnel_leads add column if not exists close_amount numeric;
alter table funnel_leads add column if not exists source text;
alter table funnel_leads add column if not exists ip text;
alter table funnel_leads alter column status set default 'lead';
