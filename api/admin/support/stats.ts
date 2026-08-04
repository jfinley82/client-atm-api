import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireAdmin } from '../../../lib/auth'
import { averageMs, CLOSED_STAGES, firstResponseMs, isBreached, resolutionMs } from '../../../lib/support'

// GET /api/admin/support/stats — the five KPI tiles plus the 14-day volume
// series behind the chart.
//
// Every ticket is read, not counted per-tile: the breach rule is a JS predicate
// over three timestamps (lib/support.ts) and cannot be expressed as a SQL count
// without restating it in a second language — which is exactly how a tile ends
// up disagreeing with the cards under it.
export const config = { maxDuration: 30 }

const MAX_SCAN = 10000
const VOLUME_DAYS = 14

// Day key in UTC. The series is a 14-bar chart, so bucketing is only ever off
// by a boundary case for an admin far from UTC; the response echoes the basis
// rather than silently picking a timezone.
function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const adminId = await requireAdmin(req, res)
  if (!adminId) return

  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, stage, first_response_at, resolved_at, created_at')
      .order('created_at', { ascending: false })
      .limit(MAX_SCAN)
    if (error) throw error

    const tickets = (data || []) as any[]
    const now = Date.now()

    const open = tickets.filter((t) => !(CLOSED_STAGES as readonly string[]).includes(t.stage))
    const awaitingFirstReply = open.filter((t) => !t.first_response_at)

    // Averages over tickets that actually reached the milestone — including
    // unanswered ones as zero would flatter the number, and excluding them is
    // why the breach tile exists alongside it.
    const avgFirstResponseMs = averageMs(tickets.map((t) => firstResponseMs(t)))
    const avgResolutionMs = averageMs(tickets.map((t) => resolutionMs(t)))

    // Lifetime, across every ticket — a ticket resolved late still counts,
    // which is why breaches can exceed the number currently open.
    const breached = tickets.filter((t) => isBreached(t, now))
    const withinSlaPct = tickets.length ? Math.round(((tickets.length - breached.length) / tickets.length) * 1000) / 10 : null

    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
    const resolvedLast7 = tickets.filter((t) => t.resolved_at && new Date(t.resolved_at).getTime() >= sevenDaysAgo).length
    const newLast7 = tickets.filter((t) => new Date(t.created_at).getTime() >= sevenDaysAgo).length

    // Fixed 14 buckets ending today, so a quiet day renders as a zero rather
    // than collapsing the axis and making the chart lie about the shape.
    const counts = new Map<string, number>()
    for (const t of tickets) {
      const k = dayKey(t.created_at)
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    const volume: { date: string; count: number }[] = []
    for (let i = VOLUME_DAYS - 1; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      volume.push({ date: d, count: counts.get(d) || 0 })
    }

    return res.status(200).json({
      stats: {
        open_tickets: open.length,
        awaiting_first_reply: awaitingFirstReply.length,
        avg_first_response_ms: avgFirstResponseMs,
        avg_resolution_ms: avgResolutionMs,
        sla_breaches: breached.length,
        within_sla_pct: withinSlaPct,
        resolved_last_7_days: resolvedLast7,
        new_last_7_days: newLast7,
        total_tickets: tickets.length,
      },
      // Targets travel with the numbers so the tile subtext ("target 24h")
      // cannot drift from the rule the breach count was computed against.
      targets: { first_response_hours: 24, resolution_hours: 72 },
      volume,
      volume_timezone: 'UTC',
      ...(tickets.length >= MAX_SCAN ? { truncated: { scanned: tickets.length, limit: MAX_SCAN } } : {}),
    })
  } catch (err) {
    console.error('[admin/support/stats] GET', err)
    return res.status(500).json({ error: 'Failed to load support stats' })
  }
}
