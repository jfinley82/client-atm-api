-- Funnel Builder Phase 3a — Google Calendar connect + per-coach availability.
-- All new objects; nothing here recreates an existing table. Verified against the
-- live DB first: calendar_connections and user_availability do NOT exist, and
-- funnels has calendar_mode/external_calendar_url but no zoom_link.

-- Per-coach OAuth connection to an external calendar (Google in 3a). One row per
-- (user, provider). The refresh_token is stored AES-256-GCM encrypted at the app
-- layer (lib/cryptoTokens, keyed by CALENDAR_TOKEN_KEY) — never plaintext. The
-- access_token is short-lived (~1h) and refreshed on demand.
create table if not exists calendar_connections (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null default 'google' check (provider in ('google')),
  access_token text,
  refresh_token text,            -- encrypted (v1:iv:tag:ciphertext), never plaintext
  expires_at timestamptz,
  calendar_id text default 'primary',
  calendar_email text,           -- the connected calendar's address (primary calendar id)
  scope text,
  connected_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, provider)
);
create index if not exists idx_calendar_connections_user on calendar_connections (user_id);

-- Per-coach availability settings, reused across all of that coach's funnels.
-- working_hours is a jsonb map: a timezone plus per-weekday { start, end } (HH:MM
-- wall-clock in that timezone) or null for a day off.
create table if not exists user_availability (
  user_id uuid primary key references users(id) on delete cascade,
  working_hours jsonb not null default '{
    "timezone": "UTC",
    "mon": {"start": "09:00", "end": "17:00"},
    "tue": {"start": "09:00", "end": "17:00"},
    "wed": {"start": "09:00", "end": "17:00"},
    "thu": {"start": "09:00", "end": "17:00"},
    "fri": {"start": "09:00", "end": "17:00"},
    "sat": null,
    "sun": null
  }'::jsonb,
  slot_minutes int not null default 30,
  buffer_minutes int not null default 15,
  booking_window_days int not null default 14,
  updated_at timestamptz default now()
);

-- The coach's pasted meeting room (used when creating the event in 3b).
alter table funnels add column if not exists zoom_link text;

-- Link a booking to the COACH whose calendar it occupies, so per-coach
-- availability can subtract that coach's booked slots. Nullable + additive: the
-- legacy shared-Zoom bookings leave it null; the funnel booking-create in 3b
-- sets it. Availability excludes active bookings where coach_user_id = the owner.
alter table bookings add column if not exists coach_user_id uuid references users(id) on delete set null;
create index if not exists idx_bookings_coach_user on bookings (coach_user_id);
