import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../lib/funnels'
import { GenerationParseError } from '../../../lib/aiJson'
import {
  FUNNEL_ASSET_TYPES,
  FunnelAssetType,
  isFunnelAssetType,
  isDerived,
  isGated,
  assetStatus,
  funnelHasBooking,
  loadFunnelGrounding,
  deriveAsset,
  generateFunnelAsset,
  listFunnelAssets,
  upsertFunnelAsset,
  LaunchAssetNotReadyError,
} from '../../../lib/funnelLaunchAssets'

// Growth Kit assets for one funnel. Response shapes are pinned by the Growth Kit
// API contract (the single source of truth shared with the frontend) — see
// lib/funnelLaunchAssets.ts for the per-asset_type `content` contracts.
//
// GET  /api/funnels/[id]/launch-assets
//   { gate: { win_the_call_unlocked, reason }, assets: { <asset_type>: { status, generated_at, content } } }
//   assets is an OBJECT keyed by asset_type (not an array), so the frontend can
//   address a row directly without scanning.
//
// POST /api/funnels/[id]/launch-assets  { asset_type }
//   { asset_type, status: 'ready', generated_at, content }
//   A locked win-the-call type returns 403 { error: 'no_booking' }.
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

  // subdomain + generation_id are what the generators and the invite derivation
  // ground on; offer_price_display is what one_pager/price_value read as this
  // funnel's own configured price (see lib/funnelLaunchAssets.ts's OfferGrounding).
  const funnel = await getOwnedFunnel(userId, id, 'id, user_id, subdomain, generation_id, status, offer_price_display')
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  if (req.method === 'GET') {
    try {
      const [rows, unlocked, grounding] = await Promise.all([
        listFunnelAssets(id),
        funnelHasBooking(id),
        // One load serves all three derived types below.
        loadFunnelGrounding(userId, funnel),
      ])
      const byType = new Map(rows.map((r) => [r.asset_type, r]))

      const assets: Record<string, { status: string; generated_at: string | null; content: unknown }> = {}
      for (const asset_type of FUNNEL_ASSET_TYPES) {
        if (isDerived(asset_type)) {
          // Always present, always current: re-derived on every read from what
          // the coach actually built (their approved warm invites, call script,
          // and objections), so it can never drift from that. generated_at is
          // null because nothing was ever generated or stored.
          assets[asset_type] = {
            status: assetStatus(asset_type, true, unlocked),
            generated_at: null,
            content: deriveAsset(grounding, asset_type),
          }
          continue
        }
        const row = byType.get(asset_type)
        const hasContent = !!row
        const status = assetStatus(asset_type, hasContent, unlocked)
        assets[asset_type] = {
          status,
          generated_at: row?.generated_at ?? null,
          // Content already generated stays readable even if the gate later
          // closes (a coach who loses their only lead keeps their work); a locked
          // type that was never generated reads null.
          content: row?.content ?? null,
        }
      }

      return res.status(200).json({
        gate: { win_the_call_unlocked: unlocked, reason: unlocked ? null : 'no_booking' },
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
    const type: FunnelAssetType = assetType

    // The booking gate. Enforced server-side, not just hidden in the UI — the
    // whole point is to not spend a generation on an asset the coach cannot use.
    if (isGated(type)) {
      const unlocked = await funnelHasBooking(id)
      if (!unlocked) return res.status(403).json({ error: 'no_booking' })
    }

    try {
      const content = await generateFunnelAsset(userId, funnel, type)

      // Derived types are computed on read and deliberately NOT persisted —
      // storing a copy would let it go stale against the coach's own build,
      // which is the one thing these assets must never do.
      if (isDerived(type)) {
        return res.status(200).json({
          asset_type: type,
          status: 'ready',
          generated_at: null,
          content,
        })
      }

      const saved = await upsertFunnelAsset(id, type, content)
      return res.status(200).json({
        asset_type: type,
        status: 'ready',
        generated_at: saved.generated_at,
        content: saved.content,
      })
    } catch (err) {
      // one_pager/price_value need an offer + synopsis to ground on — the same
      // actionable "not ready" shape POST /api/funnels/[id]/publish returns when
      // ITS inputs are missing, not a 500 and not a generation against an
      // invented offer.
      if (err instanceof LaunchAssetNotReadyError) {
        return res.status(400).json({ error: 'not_ready', missing: err.missing })
      }
      // A truncated/unparseable model response is a retryable generation failure,
      // not a server fault — same mapping the micro-training generator uses.
      if (err instanceof GenerationParseError) {
        console.error('[funnels/[id]/launch-assets] generation parse failure', type, err)
        return res.status(502).json({ error: 'generation_truncated', asset_type: type })
      }
      console.error('[funnels/[id]/launch-assets] POST', err)
      return res.status(500).json({ error: 'Failed to generate launch asset' })
    }
  }

  return res.status(405).end()
}
