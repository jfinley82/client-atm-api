import { supabase } from './supabase'

// Public Training Hub shared logic (Phase Hub v1).

// The domain public funnels + the hub itself live on. Same env the nurture /
// booking links use, so every public URL stays on one domain.
const FUNNEL_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'

// Fixed category taxonomy — a CLOSED list, validated on write. Stored lowercase;
// the render capitalizes the first letter for the sentence-case heading.
export const HUB_CATEGORIES = [
  'sales and closing',
  'offers and pricing',
  'marketing and leads',
  'mindset',
  'coaching skills',
  'content and social',
  'scaling and operations',
  'health and fitness',
  'money and finance',
  'relationships',
] as const

const CATEGORY_SET = new Set<string>(HUB_CATEGORIES)

export function isValidCategory(v: unknown): v is string {
  return typeof v === 'string' && CATEGORY_SET.has(v.trim().toLowerCase())
}

// Bounds for the admin-written, publicly-rendered text fields.
export const TITLE_MAX = 200
export const HOOK_MAX = 300
export const COACH_NAME_MAX = 120

export type HubCard = {
  id: string
  title: string
  hook: string | null
  coach_name: string
  category: string
  cover_url: string | null
  featured: boolean
  target_url: string
}

function funnelPublicUrl(subdomain: string): string {
  return `https://${subdomain}.${FUNNEL_DOMAIN}`
}

// Supabase returns an embedded row as an object or a single-element array
// depending on the relationship — normalize both.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

// The public feed: published listings whose funnel is still live, featured-first
// then sort_order then newest. A listing whose funnel was unpublished/deleted
// drops out automatically (inner join on the live funnel).
export async function loadPublishedListings(): Promise<HubCard[]> {
  const { data, error } = await supabase
    .from('hub_listings')
    .select('id, title, hook, coach_name, category, cover_url, featured, sort_order, created_at, funnels!inner(subdomain, status)')
    .eq('status', 'published')
    .eq('funnels.status', 'live')
    .order('featured', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[hub] loadPublishedListings', error)
    return []
  }

  const cards: HubCard[] = []
  for (const row of (data || []) as Record<string, any>[]) {
    const funnel = one<{ subdomain?: string | null; status?: string | null }>(row.funnels)
    const subdomain = funnel?.subdomain
    if (typeof subdomain !== 'string' || !subdomain) continue // no reachable URL
    cards.push({
      id: String(row.id),
      title: typeof row.title === 'string' ? row.title : '',
      hook: typeof row.hook === 'string' && row.hook.trim() ? row.hook : null,
      coach_name: typeof row.coach_name === 'string' ? row.coach_name : '',
      category: typeof row.category === 'string' ? row.category : '',
      cover_url: typeof row.cover_url === 'string' && row.cover_url ? row.cover_url : null,
      featured: row.featured === true,
      target_url: funnelPublicUrl(subdomain),
    })
  }
  return cards
}

// First whitespace-delimited token of a name, for the coach-name fallback.
export function firstName(name: unknown): string {
  return typeof name === 'string' && name.trim() ? name.trim().split(/\s+/)[0] : ''
}

// Suggested listing title from a funnel: the landing headline, else the
// blueprint label, else the subdomain.
export function suggestedTitle(funnel: Record<string, any>): string {
  const lp = (funnel.landing_page || {}) as Record<string, unknown>
  const headline = typeof lp.headline === 'string' && lp.headline.trim() ? lp.headline.trim() : ''
  const label = typeof funnel.problem_solution_label === 'string' && funnel.problem_solution_label.trim() ? funnel.problem_solution_label.trim() : ''
  const sub = typeof funnel.subdomain === 'string' ? funnel.subdomain : ''
  return headline || label || sub || 'Free training'
}

// Suggested coach name: the account-level business name, else the coach's first
// name, else a neutral default.
export function suggestedCoachName(businessName: unknown, userName: unknown): string {
  const biz = typeof businessName === 'string' && businessName.trim() ? businessName.trim() : ''
  return biz || firstName(userName) || 'Coach'
}

export function publicUrlForSubdomain(subdomain: string): string {
  return funnelPublicUrl(subdomain)
}
