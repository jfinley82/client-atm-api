-- Adds the column the avatar-upload feature (POST /api/auth/upload-avatar)
-- writes to and GET /api/auth/me reads back.
alter table users add column if not exists avatar_url text;
