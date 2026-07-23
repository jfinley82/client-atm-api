import { supabase } from './supabase'
import { requireActiveUser } from './auth'

/**
 * Access gate for the Funnel Builder. Mirrors the inline membership_tier gate
 * used in api/generate and api/tools/chat (fetch the user, check an entitlement
 * field, 403 on failure).
 *
 * Phase 1 widens the gate: access is granted if ANY of these hold —
 *   - role === 'admin'                    (admins always pass, same as elsewhere)
 *   - membership_tier === 'full'          (the tier that bundles the builder)
 *   - add_ons.funnel_builder === true     (the standalone add-on purchase)
 * The three fields are fetched in one query.
 *
 * Composes requireActiveUser: verifies the session + active account first,
 * then access. Writes the error response and returns null on failure
 * (401 Unauthorized / 403 account_suspended / 403 funnel_builder_required);
 * returns the userId on success. The failure shape is unchanged.
 */
export async function requireFunnelBuilder(req: any, res: any): Promise<string | null> {
  const userId = await requireActiveUser(req, res)
  if (!userId) return null

  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier, role, add_ons')
    .eq('id', userId)
    .single()

  const hasAccess =
    gateUser?.role === 'admin' ||
    gateUser?.membership_tier === 'full' ||
    gateUser?.add_ons?.funnel_builder === true

  if (!hasAccess) {
    res.status(403).json({ error: 'funnel_builder_required' })
    return null
  }

  return userId
}

// The three MTM blueprint sessions a member completes before building a funnel.
export const BLUEPRINT_SESSIONS = ['audience', 'transformation', 'problem_solution'] as const

/**
 * Blueprint completion gate, used only on funnel creation.
 *
 * Adapted to how the blueprint is actually stored in this codebase (the prompt
 * assumed a users.saved_outputs JSONB with per-session `.completed` flags — that
 * does not exist here):
 *   - audience / transformation  -> a row in the saved_outputs table
 *   - problem_solution           -> a validated problem_solution_cards row
 *     (the "matcher" session's output; validated:true is set when the pair is done)
 *
 * Returns which sessions are still missing so the frontend can show a checklist.
 */
export async function checkBlueprintComplete(
  userId: string
): Promise<{ complete: boolean; missing: string[] }> {
  const [{ data: outputs }, { data: cards }] = await Promise.all([
    supabase.from('saved_outputs').select('tool_type, content').eq('user_id', userId),
    supabase
      .from('problem_solution_cards')
      .select('id')
      .eq('user_id', userId)
      .eq('validated', true)
      .limit(1),
  ])

  // Completion is an explicit flag in the saved_outputs content, not row
  // existence: audience/transformation are now persisted every turn, so a row
  // appears after the first message. content.completed === true is set only when
  // the session genuinely finishes. The problem_solution leg already checks a
  // real completion boolean (problem_solution_cards.validated, set only at
  // matcher finalize), so it needs no equivalent guard.
  const completedTypes = new Set(
    (outputs || []).filter((o: any) => o.content?.completed === true).map((o: any) => o.tool_type)
  )
  const done: Record<string, boolean> = {
    audience: completedTypes.has('audience'),
    transformation: completedTypes.has('transformation'),
    problem_solution: (cards || []).length > 0,
  }

  const missing = BLUEPRINT_SESSIONS.filter((s) => !done[s])
  return { complete: missing.length === 0, missing }
}

/**
 * Resolve the blueprint card behind a generation_id, scoped to the owner.
 * Verifies the mtm_generations row belongs to userId, then loads the
 * problem_solution_cards row it was built from. Returns null when the
 * generation does not exist / is not owned / has no card. Used on funnel
 * creation to snapshot the blueprint's problem/solution.
 */
export async function resolveGenerationCard(
  userId: string,
  generationId: string
): Promise<Record<string, any> | null> {
  const { data: gen } = await supabase
    .from('mtm_generations')
    .select('id, user_id, card_id')
    .eq('id', generationId)
    .maybeSingle()

  if (!gen || gen.user_id !== userId || !gen.card_id) return null

  const { data: card } = await supabase
    .from('problem_solution_cards')
    .select('id, card_name, surface_problem, real_problem, your_solution, transformation, natural_bridge, hook_angle')
    .eq('id', gen.card_id)
    .maybeSingle()

  return card ?? null
}

// funnel_events types that count as true ENGAGEMENT for a lead's activity feed —
// an inclusion allowlist (safer than excluding page-views, so a future page-view
// type can never leak into the feed). Page reaches (landing_view, training_view,
// booking_click) are deliberately absent: they stay in the aggregate KPI counts
// only. Video/email types are appended by Phases 4/5 when those events exist.
export const ENGAGEMENT_EVENT_TYPES = ['signup', 'booked', 'closed', 'sold', 'video_watched', 'video_completed', 'email_opened', 'email_clicked'] as const

/**
 * Load a lead scoped to an owned funnel: confirms the funnel is owned AND the
 * lead belongs to it. Returns the lead row (selected columns) or null — callers
 * 404 on null so a foreign funnel/lead is indistinguishable from missing.
 */
export async function getOwnedLead(
  userId: string,
  funnelId: string,
  leadId: string,
  columns = 'id, status'
): Promise<Record<string, any> | null> {
  const funnel = await getOwnedFunnel(userId, funnelId)
  if (!funnel) return null
  const { data } = await supabase
    .from('funnel_leads')
    .select(columns)
    .eq('id', leadId)
    .eq('funnel_id', funnelId)
    .maybeSingle()
  return (data as Record<string, any>) ?? null
}

/**
 * Resolve a LIVE funnel for the public pages, by subdomain or by id. Returns the
 * full row, or null when it is missing or not live. The public renderer and the
 * lead endpoint both gate on status === 'live' through this one place.
 */
export async function resolveLiveFunnel(opts: {
  subdomain?: string | null
  funnelId?: string | null
}): Promise<Record<string, any> | null> {
  let query = supabase.from('funnels').select('*')
  if (opts.funnelId) query = query.eq('id', opts.funnelId)
  else if (opts.subdomain) query = query.eq('subdomain', opts.subdomain)
  else return null

  const { data: funnel } = await query.maybeSingle()
  if (!funnel || funnel.status !== 'live') return null
  return funnel
}

// ---- brand-field validation --------------------------------------------
// These values are interpolated into the PUBLIC render's <style> and <script>,
// so they must be strictly validated on write AND sanitized on read. A raw
// brand_font / color could otherwise break out of the CSS/JS context and inject
// markup on the live *.microtrainingmethod.com page (stored XSS).

export const DEFAULT_BRAND_PRIMARY = '#020c31'
export const DEFAULT_BRAND_SECONDARY = '#6dd80e'
export const DEFAULT_BRAND_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

// Hex (#rgb..#rrggbbaa) or a digits/percent/comma-only rgb()/hsl() form. No
// character in either form can close a <style>/<script> or start a CSS rule.
const BRAND_HEX_RE = /^#[0-9a-fA-F]{3,8}$/
const BRAND_FUNC_RE = /^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s]+\)$/

export function isValidBrandColor(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  return BRAND_HEX_RE.test(t) || BRAND_FUNC_RE.test(t)
}

// Fixed allowlist of font-family strings a coach may pick. Stored value must
// match one of these EXACTLY — never free text.
export const BRAND_FONT_ALLOWLIST: string[] = [
  DEFAULT_BRAND_FONT,
  "'Inter', sans-serif",
  "'Poppins', sans-serif",
  "'Montserrat', sans-serif",
  "'Roboto', sans-serif",
  "'Lato', sans-serif",
  "'Open Sans', sans-serif",
  "'Nunito', sans-serif",
  "'Work Sans', sans-serif",
  "'Raleway', sans-serif",
  "'Georgia', serif",
  "'Merriweather', serif",
  "'Playfair Display', serif",
  "'Courier New', monospace",
]

export function isValidBrandFont(v: unknown): v is string {
  return typeof v === 'string' && BRAND_FONT_ALLOWLIST.includes(v.trim())
}

// Read-side defense in depth: return the stored value only if it still passes
// validation, else the safe default. Used by the public renderer so even a row
// that predates validation (or is tampered directly in the DB) can't inject.
export function sanitizeBrandColor(v: unknown, fallback: string): string {
  return isValidBrandColor(v) ? v.trim() : fallback
}
export function sanitizeBrandFont(v: unknown): string {
  return isValidBrandFont(v) ? v.trim() : DEFAULT_BRAND_FONT
}

// ---- ad-pixel / tracking-ID validation ---------------------------------
// funnels.tracking = { google_tag_id, gtm_id, fb_pixel_id }. These IDs are
// injected into the PUBLIC render's <script> tags, so they carry the SAME
// stored-XSS risk as the brand fields: validate strictly on write AND sanitize
// on read. Every accepted form is a fixed prefix + [A-Z0-9] (or digits), which
// contains no quote, angle bracket, or slash — so it can never break out of the
// single-quoted string it is interpolated into.

export type Tracking = { google_tag_id?: string; gtm_id?: string; fb_pixel_id?: string }

// GA4 (G-XXXX) or Google Ads (AW-XXXX) — google_tag_id covers both.
const GTAG_ID_RE = /^(G-[A-Z0-9]{4,20}|AW-[0-9]{6,20})$/
const GTM_ID_RE = /^GTM-[A-Z0-9]{4,12}$/
const FB_PIXEL_RE = /^[0-9]{6,20}$/

const TRACKING_VALIDATORS: Record<keyof Tracking, RegExp> = {
  google_tag_id: GTAG_ID_RE,
  gtm_id: GTM_ID_RE,
  fb_pixel_id: FB_PIXEL_RE,
}
const TRACKING_KEYS = Object.keys(TRACKING_VALIDATORS) as (keyof Tracking)[]

/**
 * Validate a tracking object for WRITE (PATCH). Each present key must be a known
 * tracking key with a valid ID, or an empty string / null to clear it. An
 * unknown nested key or a malformed ID fails. Returns the cleaned object (only
 * valid IDs) to store, so a rejected value never reaches the DB or the render.
 */
export function validateTrackingInput(
  v: unknown
): { ok: true; tracking: Tracking } | { ok: false; field: string } {
  if (v === null) return { ok: true, tracking: {} }
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, field: 'tracking' }
  const obj = v as Record<string, unknown>
  const out: Tracking = {}
  for (const key of Object.keys(obj)) {
    // hasOwnProperty, NOT `key in` — `in` walks the prototype chain, so an
    // inherited key ('toString', '__proto__', 'hasOwnProperty', ...) would slip
    // the guard and then TRACKING_VALIDATORS[key] resolves to an Object.prototype
    // method with no .test → TypeError → unhandled 500 instead of a 400.
    if (!Object.prototype.hasOwnProperty.call(TRACKING_VALIDATORS, key)) {
      return { ok: false, field: `tracking.${key}` }
    }
    const raw = obj[key]
    if (raw === null || raw === '') continue // clearing this one
    if (typeof raw !== 'string' || !TRACKING_VALIDATORS[key as keyof Tracking].test(raw.trim())) {
      return { ok: false, field: `tracking.${key}` }
    }
    out[key as keyof Tracking] = raw.trim()
  }
  return { ok: true, tracking: out }
}

/**
 * Read-side defense in depth for the public render: return ONLY the tracking IDs
 * that still pass validation, dropping anything malformed or unknown. Even a row
 * written before validation (or tampered directly in the DB) can't inject a
 * script this way.
 */
export function sanitizeTracking(v: unknown): Tracking {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const obj = v as Record<string, unknown>
  const out: Tracking = {}
  for (const key of TRACKING_KEYS) {
    const raw = obj[key]
    if (typeof raw === 'string' && TRACKING_VALIDATORS[key].test(raw.trim())) out[key] = raw.trim()
  }
  return out
}

/**
 * Load a funnel and confirm ownership in one step, for the owner-scoped CRM /
 * analytics endpoints. Returns the row (selected columns) or null when it is
 * missing or owned by someone else — callers 404 on null (never leak existence).
 */
export async function getOwnedFunnel(
  userId: string,
  id: string,
  columns = 'id, user_id'
): Promise<Record<string, any> | null> {
  const cols = columns.includes('user_id') ? columns : `${columns}, user_id`
  const { data } = await supabase.from('funnels').select(cols).eq('id', id).maybeSingle()
  if (!data || (data as any).user_id !== userId) return null
  return data as Record<string, any>
}

// Subdomain: lowercase letters, numbers, hyphens only (no leading/trailing hyphen).
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function isValidSubdomain(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 63 && SUBDOMAIN_RE.test(value)
}

// System / infrastructure labels a coach must not be able to claim as a funnel
// slug — they collide with real hosts on freeminiworkshop.com (and MTM's other
// domains). Public funnels serve on {slug}.freeminiworkshop.com, so e.g. `www`
// or `mail` or `admin` as a slug would shadow or impersonate a system host.
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'app', 'mail', 'admin', 'root', 'assets', 'static', 'cdn', 'help',
  'support', 'docs', 'status', 'dashboard', 'login', 'signup', 'blog', 'cname',
  'ns1', 'ns2', 'mx', 'smtp', 'email', 'test', 'staging', 'preview', 'vercel',
])

// Case-insensitive reserved check (slugs are stored lowercase, but reject a
// mixed-case attempt too before it is normalized).
export function isReservedSubdomain(value: unknown): boolean {
  return typeof value === 'string' && RESERVED_SUBDOMAINS.has(value.trim().toLowerCase())
}

/**
 * True if `subdomain` is already taken by a different funnel. Pass the current
 * funnel id to exclude it (so a no-op PATCH of the same subdomain is allowed).
 */
export async function subdomainTaken(subdomain: string, excludeFunnelId?: string): Promise<boolean> {
  let query = supabase.from('funnels').select('id').eq('subdomain', subdomain)
  if (excludeFunnelId) query = query.neq('id', excludeFunnelId)
  const { data } = await query.limit(1)
  return (data || []).length > 0
}
