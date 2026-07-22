import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors } from '../../../lib/cors'
import {
  requireFunnelBuilder,
  isValidSubdomain,
  isReservedSubdomain,
  subdomainTaken,
  isValidBrandColor,
  isValidBrandFont,
  validateTrackingInput,
} from '../../../lib/funnels'

const THEME_MODES = ['dark', 'light']

// Every field a member may PATCH on their own funnel. A body key outside this
// set is rejected (unknown_field) rather than silently ignored.
const EDITABLE_KEYS = new Set([
  'subdomain',
  'brand_primary_color',
  'brand_secondary_color',
  'theme_mode',
  'collect_name',
  'collect_phone',
  'landing_page',
  'training_page',
  'booking_page',
  'logo_url',
  'headshot_url',
  'brand_font',
  'video_url',
  'tracking',
  'watch_threshold_pct',
])

// jsonb page/config fields — accept a plain object, or null to clear. tracking
// is NOT here: its IDs are injected into the public page's <script>, so it is
// strictly validated separately (validateTrackingInput).
const OBJECT_FIELDS = ['landing_page', 'training_page', 'booking_page']
// free-text fields — accept a string (trimmed), or null to clear. (brand_font is
// NOT here — it is allowlist-validated separately, and colors are pattern-checked.)
const TEXT_FIELDS = ['logo_url', 'headshot_url', 'video_url']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  // Load the funnel and confirm ownership (404 rather than leak existence)
  const { data: funnel, error: loadError } = await supabase
    .from('funnels')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (loadError) {
    console.error('[funnels/[id]] load', loadError)
    return res.status(500).json({ error: 'Failed to load funnel' })
  }
  if (!funnel || funnel.user_id !== userId) {
    return res.status(404).json({ error: 'Funnel not found' })
  }

  if (req.method === 'GET') {
    return res.status(200).json({ funnel })
  }

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const updates: Record<string, unknown> = {}

    // Reject unknown keys rather than silently dropping them.
    for (const key of Object.keys(body)) {
      if (!EDITABLE_KEYS.has(key)) {
        return res.status(400).json({ error: 'unknown_field', field: key })
      }
    }

    if ('subdomain' in body) {
      const { subdomain } = body
      // Lock the subdomain once live — a live funnel's public URL is fixed.
      const changing = subdomain !== funnel.subdomain
      if (funnel.status === 'live' && changing) {
        return res.status(409).json({ error: 'subdomain_locked' })
      }
      if (subdomain === null) {
        updates.subdomain = null
      } else {
        if (!isValidSubdomain(subdomain)) {
          return res.status(400).json({
            error: 'invalid_subdomain',
            message: 'subdomain must be lowercase letters, numbers, and hyphens only',
          })
        }
        if (isReservedSubdomain(subdomain)) {
          return res.status(409).json({ error: 'reserved_subdomain', message: 'that subdomain is reserved' })
        }
        if (changing && (await subdomainTaken(subdomain as string, id))) {
          return res.status(409).json({ error: 'subdomain_taken' })
        }
        updates.subdomain = subdomain
      }
    }

    // Brand colors are interpolated into the public page's CSS/JS — validate
    // strictly (hex or rgb()/hsl()) so a value can't break out of that context.
    for (const field of ['brand_primary_color', 'brand_secondary_color']) {
      if (field in body) {
        if (!isValidBrandColor(body[field])) {
          return res.status(400).json({ error: 'invalid_field', field, message: 'must be a hex or rgb()/hsl() color' })
        }
        updates[field] = (body[field] as string).trim()
      }
    }

    // brand_font must be an allowlisted font-family string (never free text) —
    // same public-CSS injection surface as colors.
    if ('brand_font' in body) {
      if (body.brand_font !== null && !isValidBrandFont(body.brand_font)) {
        return res.status(400).json({ error: 'invalid_field', field: 'brand_font', message: 'must be an allowed font-family' })
      }
      updates.brand_font = body.brand_font === null ? null : (body.brand_font as string).trim()
    }

    if ('theme_mode' in body) {
      if (!THEME_MODES.includes(body.theme_mode as string)) {
        return res.status(400).json({ error: 'invalid_theme_mode', message: "theme_mode must be 'dark' or 'light'" })
      }
      updates.theme_mode = body.theme_mode
    }

    if ('collect_name' in body) updates.collect_name = !!body.collect_name
    if ('collect_phone' in body) updates.collect_phone = !!body.collect_phone

    // jsonb page/config fields — object, or null to clear.
    for (const field of OBJECT_FIELDS) {
      if (field in body) {
        const v = body[field]
        if (v !== null && !isPlainObject(v)) {
          return res.status(400).json({ error: 'invalid_field', field, message: `${field} must be an object or null` })
        }
        updates[field] = v
      }
    }

    // free-text fields — trimmed string, or null to clear.
    for (const field of TEXT_FIELDS) {
      if (field in body) {
        const v = body[field]
        if (v !== null && typeof v !== 'string') {
          return res.status(400).json({ error: 'invalid_field', field, message: `${field} must be a string or null` })
        }
        updates[field] = v === null ? null : (v as string).trim()
      }
    }

    // Ad-pixel / tracking IDs — validated strictly (same public-<script>
    // injection surface as brand fields). Stores only the cleaned, valid IDs.
    if ('tracking' in body) {
      const parsed = validateTrackingInput(body.tracking)
      if (!parsed.ok) {
        return res.status(400).json({ error: 'invalid_field', field: parsed.field, message: 'malformed tracking id' })
      }
      updates.tracking = parsed.tracking
    }

    if ('watch_threshold_pct' in body) {
      const n = Number(body.watch_threshold_pct)
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'invalid_field', field: 'watch_threshold_pct', message: 'must be 0-100' })
      }
      updates.watch_threshold_pct = Math.round(n)
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' })
    }

    updates.updated_at = new Date().toISOString()

    try {
      const { data, error } = await supabase
        .from('funnels')
        .update(updates)
        .eq('id', id)
        .eq('user_id', userId)
        .select('*')
        .single()

      if (error) throw error
      return res.status(200).json({ funnel: data })
    } catch (err) {
      console.error('[funnels/[id]] PATCH', err)
      return res.status(500).json({ error: 'Failed to update funnel' })
    }
  }

  return res.status(405).end()
}
