-- 'sold' is a won/revenue lead status (funnel_leads_status_check already allows
-- it). Allow it as a funnel_event too, so a transition into sold logs an event on
-- the lead timeline like booked/closed. DROP + re-ADD over the current set (048),
-- same pattern as 042/044/047/048.
alter table funnel_events drop constraint if exists funnel_events_event_type_check;
alter table funnel_events add constraint funnel_events_event_type_check
  check (event_type = any (array[
    'landing_view', 'training_view', 'signup', 'booking_click', 'booked', 'closed',
    'video_watched', 'video_completed', 'email_opened', 'email_clicked', 'sold'
  ]));
