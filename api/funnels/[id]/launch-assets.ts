import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../lib/funnels'
import { GenerationParseError } from '../../../lib/aiJson'
import {
  FUNNEL_ASSET_TYPES,
  WIN_THE_CALL_TYPES,
  isFunnelAssetType,
  isWinTheCall,
  funnelHasBooking,
  generateFunnelAsset,
  listFunnelAssets,
  upsertFunnelAsset,
} from '../../../lib/funnelLaunchAssets'

// Growth Kit assets for one funnel.
//
// GET  /api/funnels/[id]/launch-assets
//   Returns every asset type with its generated content (null when not yet
//   generated) plus the booking gate state, so the tab can render the full grid
//   — including the locked win-the-call four — in one call.
//
// POST /api/funnels/[id]/launch-assets  { asset_type }
//   Generates (or regenerates) ONE asset type on demand and upserts it.
//
// Owner-scoped via requireFunnelBuilder + getOwnedFunnel; the funnel_builder
// entitlement and the $1,497 checkout already exist, so there is no new auth here.
export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  // subdomain + generation_id are what the generators ground on.
  const funnel = await getOwnedFunnel(userId, id, 'id, user_id, subdomain, generation_id, status')
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  if (req.method === 'GET') {
    try {
      const [rows, hasBooking] = await Promise.all([listFunnelAssets(id), funnelHasBooking(id)])
      const byType = new Map(rows.map((r) => [r.asset_type, r]))

      const assets = FUNNEL_ASSET_TYPES.map((asset_type) => {
        const row = byType.get(asset_type)
        const gated = isWinTheCall(asset_type)
        return {
          asset_type,
          // The win-the-call four stay locked until the funnel has a booking.
          // Already-generated content is still returned if the gate later closes
          // (a coach who generated then deleted their only lead keeps their work).
          locked: gated && !hasBooking,
          gated_on_booking: gated,
          content: row?.content ?? null,
          generated_at: row?.generated_at ?? null,
        }
      })

      return res.status(200).json({
        funnel_id: id,
        has_booking: hasBooking,
        win_the_call_types: WIN_THE_CALL_TYPES,
        assets,
      })
    } catch (err) {
      console.error('[funnels/[id]/launch-assets] GET', err)
      return res.status(500).json({ error: 'Failed to load launch assets' })
    }
  }

  if (req.method === 'POST') {
    const assetType = (req.body || {}).asset_type
    if (!isFunnelAssetType(assetType)) {
      return res.status(400).json({ error: 'asset_type required', allowed: FUNNEL_ASSET_TYPES })
    }

    // The booking gate. Enforced server-side, not just hidden in the UI — the
    // whole point is to not spend a generation on an asset the coach cannot use.
    if (isWinTheCall(assetType)) {
      const hasBooking = await funnelHasBooking(id)
      if (!hasBooking) {
        return res.status(409).json({
          error: 'booking_required',
          message: 'Generate this once the funnel has at least one booking.',
          asset_type: assetType,
        })
      }
    }

    try {
      const content = await generateFunnelAsset(userId, funnel, assetType)
      const saved = await upsertFunnelAsset(id, assetType, content)
      return res.status(200).json({ asset: saved })
    } catch (err) {
      // A truncated/unparseable model response is a retryable generation failure,
      // not a server fault — same mapping the micro-training generator uses.
      if (err instanceof GenerationParseError) {
        console.error('[funnels/[id]/launch-assets] generation parse failure', assetType, err)
        return res.status(502).json({ error: 'generation_truncated', asset_type: assetType })
      }
      console.error('[funnels/[id]/launch-assets] POST', err)
      return res.status(500).json({ error: 'Failed to generate launch asset' })
    }
  }

  return res.status(405).end()
}
