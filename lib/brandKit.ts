import { sanitizeBrandColor, sanitizeBrandFont, DEFAULT_BRAND_PRIMARY, DEFAULT_BRAND_SECONDARY } from './funnels'
import { isValidHttpUrl, type BusinessSettings } from './businessSettings'

// The coach's visual identity, derived ONCE from funnel_business_settings.
//
// Lifted out of api/funnels/render.ts unchanged. It moved because the client
// portal is a third surface that has to paint a coach's colours, and the two
// surfaces that already did it had arrived at the same eight tokens
// independently. A third independent copy is how they start disagreeing: the
// coach sees one background on their funnel page and their client sees another,
// with nothing anywhere saying which is right.
//
// SANITIZED ON READ, not trusted from write. Every value here is interpolated
// into a <style> block, so it must be a validated colour or an allowlisted font
// whether or not it passed validation on the way in.

export type Brand = {
  primary: string
  secondary: string
  isDark: boolean
  text: string
  bg: string
  muted: string
  card: string
  font: string
}

export function brandKit(settings: BusinessSettings): Brand {
  const primary = sanitizeBrandColor(settings.brand_primary_color, DEFAULT_BRAND_PRIMARY)
  const secondary = sanitizeBrandColor(settings.brand_secondary_color, DEFAULT_BRAND_SECONDARY)
  const isDark = settings.theme_mode !== 'light'
  const font = sanitizeBrandFont(settings.brand_font)
  return {
    primary,
    secondary,
    isDark,
    font,
    // brand_primary_color IS the background in the default dark theme, and the
    // text colour on light. One value, two jobs, decided by theme_mode.
    text: isDark ? '#ffffff' : primary,
    bg: isDark ? primary : '#ffffff',
    muted: isDark ? 'rgba(255,255,255,.72)' : 'rgba(2,12,49,.72)',
    card: isDark ? 'rgba(255,255,255,.06)' : 'rgba(2,12,49,.04)',
  }
}

// First value that is a usable http(s) URL. Used for the logo/headshot
// precedence chain; re-validating here means a value written before the URL
// check existed still can't render a javascript: src.
export function firstUrl(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() && isValidHttpUrl(c.trim())) return c.trim()
  }
  return null
}
