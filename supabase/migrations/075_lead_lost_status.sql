-- A terminal NOT-won outcome for a lead.
--
-- funnel_leads.status had no such value: the set was
-- lead/watching/booked/showed/no_show/sold/closed, where BOTH 'sold' and
-- 'closed' mean won — that is exactly what every analytics path filters on
-- (`.in('status', ['sold','closed'])` in api/funnels/analytics.ts,
-- api/funnels/portfolio.ts, api/funnels/[id]/analytics.ts). So a coach could
-- record a win but had nowhere to record a loss, and 'closed' is unavailable
-- for it despite the name.
--
-- 'lost' is deliberately outside that won filter, so recording a loss moves the
-- lead out of the pipeline without touching Closed or Revenue anywhere.
-- DROP + re-ADD over the current set, the same pattern 042/047/053/063 used —
-- every existing value is carried forward.
alter table funnel_leads drop constraint if exists funnel_leads_status_check;
alter table funnel_leads add constraint funnel_leads_status_check
  check (status = any (array[
    'lead', 'watching', 'booked', 'showed', 'no_show', 'sold', 'closed', 'lost'
  ]));

comment on column funnel_leads.status is
  'Pipeline state. sold/closed are the WON pair every revenue rollup filters on; lost is terminal not-won and is excluded from those rollups by construction.';
