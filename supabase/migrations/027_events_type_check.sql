-- Tightens events.event_type now that the real 3 category values are
-- confirmed from the live Admin > Events "Add Event" form dropdown
-- ("Office Hours", "Workshop", "Live Call") — left as free TEXT in
-- 026_events.sql only because those values weren't confirmed yet at the
-- time. Same drop-then-add idiom used elsewhere in this repo for
-- tightening an enum after the fact (e.g. saved_outputs_tool_type_check).
alter table events drop constraint if exists events_event_type_check;
alter table events add constraint events_event_type_check
  check (event_type in ('Office Hours', 'Workshop', 'Live Call'));
