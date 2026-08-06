-- Bucket-level size and mime enforcement for the two image buckets that are
-- moving to signed upload URLs.
--
-- WHY THIS IS REQUIRED, not a hardening nicety. Until now every write to these
-- buckets went through a serverless function that checked the size and the mime
-- type itself, so both bucket columns being NULL was harmless. A signed upload
-- URL takes the function out of the transfer path — that is the entire point,
-- since a function can never receive more than ~4.5MB — which means the checks
-- have to live somewhere the browser cannot skip. That somewhere is here.
--
-- Shipping api/forum/upload-url.ts or api/slides/upload-url.ts without this
-- would turn each bucket into an unbounded public write endpoint for anyone
-- holding a valid session.
--
-- 10485760 = 10MB, and it must stay in step with SIGNED_UPLOAD_MAX_BYTES in
-- lib/uploadUrl.ts: the constant is what members are told, this is what actually
-- refuses them.
--
-- The mime list matches IMAGE_EXT_BY_TYPE in the same file. Existing objects are
-- unaffected; both columns apply to new uploads only.

update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
where id in ('forum-media', 'slide-images');
