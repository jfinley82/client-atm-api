import { supabase } from './supabase'

// Signed upload URLs — the way past the platform body cap described in
// lib/rawBody.ts.
//
// A direct-to-function upload can never exceed roughly 4.5MB, because the
// request has to survive the edge before our code exists. A signed upload URL
// removes the function from the transfer path altogether: the API mints a
// short-lived, single-path credential and the browser PUTs the bytes straight to
// Supabase storage. The ceiling goes with it, and a 4MB image stops occupying a
// lambda for three seconds doing nothing but relaying bytes.
//
// WHAT ENFORCES WHAT, once the function is out of the way:
//
//   path      — us. The prefix is built server-side from the session and the
//               filename is generated here, so a member can only ever write
//               inside their own prefix. Nothing from the request body reaches
//               the path.
//   mime type — the bucket (allowed_mime_types) is authoritative. The check
//               below runs first so the caller gets a readable 415 before
//               uploading, but it is a courtesy, not the gate.
//   size      — the bucket (file_size_limit) is authoritative. declaredBytes
//               below is client-supplied and therefore advisory only; it exists
//               so an oversized file is refused before it is transferred rather
//               than after. Both are set by supabase/migrations/087.
//
// That split matters. Before 087 both buckets had file_size_limit and
// allowed_mime_types NULL, which was harmless while every write went through a
// function that checked them — and would have been an unbounded public write
// endpoint the moment one didn't.

export const IMAGE_EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// The real limit for the signed path, and the number migration 087 writes to
// both buckets. Keep the two in step: this constant is what members are told,
// the bucket is what actually refuses them.
export const SIGNED_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const SIGNED_UPLOAD_MAX_LABEL = '10MB'

export type SignedUploadBucket = 'forum-media' | 'slide-images'

export type SignedImageUpload = {
  bucket: SignedUploadBucket
  path: string
  // Full URL. The browser PUTs the raw file to it with the matching
  // Content-Type — no Supabase client needed on the frontend:
  //   fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': type }, body: file })
  uploadUrl: string
  // Same credential as a bare token, for a caller that would rather use
  // supabase-js: storage.from(bucket).uploadToSignedUrl(path, token, file).
  token: string
  // Where the image will be readable once the PUT succeeds.
  publicUrl: string
  maxBytes: number
}

export type SignImageResult =
  | { ok: true; upload: SignedImageUpload }
  | { ok: false; status: number; error: string }

// A path segment we are willing to interpolate. Ids only — no dots, no slashes,
// so nothing a caller supplies can climb out of its own prefix.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

export function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SEGMENT.test(value)
}

/**
 * Mint a signed upload URL for one image.
 *
 * `prefix` is the caller's responsibility and must be built from the session,
 * never from the request body — it is what confines a member to their own
 * space. Every segment is checked against SAFE_SEGMENT regardless, so a bad
 * caller fails closed rather than writing somewhere it shouldn't.
 */
export async function signImageUpload(opts: {
  bucket: SignedUploadBucket
  prefix: string
  contentType: string
  declaredBytes?: number | null
}): Promise<SignImageResult> {
  const contentType = (opts.contentType || '').split(';')[0].trim().toLowerCase()
  const ext = IMAGE_EXT_BY_TYPE[contentType]
  if (!ext) {
    return { ok: false, status: 415, error: 'Unsupported image type — png, jpeg, webp, and gif only' }
  }

  const segments = opts.prefix.split('/').filter(Boolean)
  if (!segments.length || !segments.every(isSafePathSegment)) {
    return { ok: false, status: 400, error: 'invalid_upload_prefix' }
  }

  const declared = opts.declaredBytes
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > SIGNED_UPLOAD_MAX_BYTES) {
    return { ok: false, status: 413, error: `Image must be ${SIGNED_UPLOAD_MAX_LABEL} or smaller` }
  }

  // A NEW object per upload — timestamp + short random keep paths unique, so a
  // re-upload never clobbers an earlier one and upsert can stay off.
  const rand = Math.random().toString(36).slice(2, 8)
  const path = `${segments.join('/')}/${Date.now()}-${rand}.${ext}`

  const { data, error } = await supabase.storage.from(opts.bucket).createSignedUploadUrl(path)
  if (error || !data) {
    console.error('[uploadUrl] createSignedUploadUrl', opts.bucket, error)
    return { ok: false, status: 500, error: 'Failed to prepare upload' }
  }

  const { data: publicUrlData } = supabase.storage.from(opts.bucket).getPublicUrl(path)

  return {
    ok: true,
    upload: {
      bucket: opts.bucket,
      path,
      uploadUrl: data.signedUrl,
      token: data.token,
      // Cache-busted for the same reason the direct uploaders do it: the path is
      // new, so anything that fetched it before the PUT landed would otherwise
      // be able to serve a cached miss.
      publicUrl: `${publicUrlData.publicUrl}?v=${Date.now()}`,
      maxBytes: SIGNED_UPLOAD_MAX_BYTES,
    },
  }
}
