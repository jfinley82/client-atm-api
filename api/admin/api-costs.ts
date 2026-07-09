import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

type Period = 'day' | 'week' | 'month'

function parseDateParam(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

// Computes the [start, end) UTC range for the given period, anchored on the
// given date (defaults to today UTC when no date is provided). Week is the
// ISO week (Monday-Sunday) containing the anchor date; month is the anchor
// date's calendar month.
function resolveRange(period: Period, anchor: Date): { start: Date; end: Date } {
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth()
  const day = anchor.getUTCDate()

  if (period === 'day') {
    const start = new Date(Date.UTC(year, month, day))
    const end = new Date(Date.UTC(year, month, day + 1))
    return { start, end }
  }

  if (period === 'week') {
    // getUTCDay(): 0 = Sunday .. 6 = Saturday. Convert to Monday-first offset.
    const dow = anchor.getUTCDay()
    const offsetFromMonday = dow === 0 ? 6 : dow - 1
    const start = new Date(Date.UTC(year, month, day - offsetFromMonday))
    const end = new Date(Date.UTC(year, month, day - offsetFromMonday + 7))
    return { start, end }
  }

  // month
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 1))
  return { start, end }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  const { data: actingUser } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (!actingUser || actingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const rawPeriod = req.query && req.query.period
  const period = Array.isArray(rawPeriod) ? rawPeriod[0] : rawPeriod
  if (period !== 'day' && period !== 'week' && period !== 'month') {
    return res.status(400).json({ error: 'period must be one of day, week, month' })
  }

  const rawDate = req.query && req.query.date
  const dateParam = Array.isArray(rawDate) ? rawDate[0] : rawDate
  let anchor: Date
  if (dateParam !== undefined) {
    const parsed = parseDateParam(dateParam)
    if (!parsed) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' })
    anchor = parsed
  } else {
    const now = new Date()
    anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  }

  const { start, end } = resolveRange(period, anchor)

  try {
    const { data, error } = await supabase
      .from('api_cost_log')
      .select('tool_type, cost_usd')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())

    if (error) throw error

    const rows = data || []
    const byToolType = new Map<string, { cost_usd: number; call_count: number }>()
    let total_cost_usd = 0

    for (const row of rows) {
      const cost = typeof row.cost_usd === 'number' ? row.cost_usd : Number(row.cost_usd) || 0
      total_cost_usd += cost
      const existing = byToolType.get(row.tool_type) || { cost_usd: 0, call_count: 0 }
      existing.cost_usd += cost
      existing.call_count += 1
      byToolType.set(row.tool_type, existing)
    }

    const breakdown = Array.from(byToolType.entries())
      .map(([tool_type, v]) => ({
        tool_type,
        cost_usd: Math.round(v.cost_usd * 1_000_000) / 1_000_000,
        call_count: v.call_count,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd)

    return res.status(200).json({
      period,
      date: anchor.toISOString().slice(0, 10),
      range: { start: start.toISOString(), end: end.toISOString() },
      total_cost_usd: Math.round(total_cost_usd * 1_000_000) / 1_000_000,
      breakdown,
    })
  } catch (err) {
    console.error('[admin/api-costs] GET', err)
    return res.status(500).json({ error: 'Failed to load API costs' })
  }
}
