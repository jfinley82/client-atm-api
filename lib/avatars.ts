// Curated persona avatars — a fixed set of pre-rendered, professional,
// diverse illustrated portraits served as static assets from the API host at
// /avatars/persona-NN.svg (public/avatars/). These are open-license (CC0)
// openPeeps illustrations rendered once at build-authoring time; runtime does
// NOT depend on any avatar-generation library and there is no per-persona image
// generation, storage, or moderation.
//
// One avatar is picked deterministically per persona from a stable seed, so the
// same persona always resolves to the same face. Pure hash -> index; no gender
// or role bias (kept simple on purpose).

const API_URL = process.env.API_URL || 'https://client-atm-api-workwithjamaul-4008s-projects.vercel.app'

// Number of curated assets in public/avatars (persona-01.svg .. persona-20.svg).
const AVATAR_COUNT = 20

// Stable, deterministic 32-bit string hash (FNV-1a). Must NOT use Math.random or
// any per-process state — the same seed has to map to the same avatar across
// requests, deploys, and endpoints.
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    // h *= 16777619, kept in 32-bit range via Math.imul
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// Map a seed to a stable persona-NN.svg filename.
export function avatarFilenameForSeed(seed: string | null | undefined): string {
  const s = (seed || '').trim() || 'default'
  const idx = (hashSeed(s) % AVATAR_COUNT) + 1
  return `persona-${String(idx).padStart(2, '0')}.svg`
}

// Full public URL for the persona avatar chosen for this seed.
export function avatarUrlForSeed(seed: string | null | undefined): string {
  return `${API_URL}/avatars/${avatarFilenameForSeed(seed)}`
}

// The persona is user-level: one Audience avatar (`avatar_name`) per coach, shown
// identically on the Audience step and the Launch persona tile (and every Launch
// library card, which all target that same persona). So the avatar seed is the
// persona identity, NOT the per-card id — seeding by card_id would give one coach's
// single persona a different face on every micro-training. Falls back to userId so
// the face is still stable before a persona has been named.
export function personaSeedFromAudience(audienceContent: unknown, userId: string): string {
  const c = audienceContent && typeof audienceContent === 'object' ? (audienceContent as Record<string, unknown>) : null
  const name = c && typeof c.avatar_name === 'string' ? c.avatar_name.trim() : ''
  return name || userId
}
