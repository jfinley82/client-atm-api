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
      .select('tool_type, cost_usd, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())

    if (error) throw error

    const rows = data || []
    type Agg = {
      cost_usd: number
      call_count: number
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    }
    const emptyAgg = (): Agg => ({
      cost_usd: 0,
      call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    const byToolType = new Map<string, Agg>()
    let total_cost_usd = 0
    const totals = emptyAgg()

    const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

    for (const row of rows) {
      const cost = num(row.cost_usd)
      total_cost_usd += cost
      const existing = byToolType.get(row.tool_type) || emptyAgg()
      existing.cost_usd += cost
      existing.call_count += 1
      existing.input_tokens += num(row.input_tokens)
      existing.output_tokens += num(row.output_tokens)
      existing.cache_creation_input_tokens += num(row.cache_creation_input_tokens)
      existing.cache_read_input_tokens += num(row.cache_read_input_tokens)
      byToolType.set(row.tool_type, existing)

      totals.call_count += 1
      totals.input_tokens += num(row.input_tokens)
      totals.output_tokens += num(row.output_tokens)
      totals.cache_creation_input_tokens += num(row.cache_creation_input_tokens)
      totals.cache_read_input_tokens += num(row.cache_read_input_tokens)
    }

    // Share of billable INPUT that was served from cache. Denominator is every
    // input bucket (uncached + freshly written + read), so a period with no
    // caching reads 0 and a fully-warm period approaches 1 — this is the single
    // number that says whether the caching rollout is working.
    const cacheDenom =
      totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens
    const cache_hit_rate = cacheDenom > 0 ? Math.round((totals.cache_read_input_tokens / cacheDenom) * 10_000) / 10_000 : 0

    const breakdown = Array.from(byToolType.entries())
      .map(([tool_type, v]) => ({
        tool_type,
        cost_usd: Math.round(v.cost_usd * 1_000_000) / 1_000_000,
        call_count: v.call_count,
        input_tokens: v.input_tokens,
        output_tokens: v.output_tokens,
        cache_creation_input_tokens: v.cache_creation_input_tokens,
        cache_read_input_tokens: v.cache_read_input_tokens,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd)

    return res.status(200).json({
      period,
      date: anchor.toISOString().slice(0, 10),
      range: { start: start.toISOString(), end: end.toISOString() },
      total_cost_usd: Math.round(total_cost_usd * 1_000_000) / 1_000_000,
      // Prompt-caching rollout metrics — the before/after signal.
      tokens: {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cache_creation_input_tokens: totals.cache_creation_input_tokens,
        cache_read_input_tokens: totals.cache_read_input_tokens,
        cache_hit_rate,
      },
      breakdown,
    })
  } catch (err) {
    console.error('[admin/api-costs] GET', err)
    return res.status(500).json({ error: 'Failed to load API costs' })
  }
}
