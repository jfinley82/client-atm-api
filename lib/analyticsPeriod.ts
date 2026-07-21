// Pure helpers for period-over-period analytics windows. No I/O — the endpoint
// injects `nowMs` and runs the date-windowed queries, so this stays testable.

export type Window = { start: string; end: string } // UTC ISO
export type PeriodWindows = { current: Window; previous: Window }
export type Period = 'month' | 'week' | '7d' | '30d' | '90d'

const DAY = 24 * 3600_000

export function normalizePeriod(v: unknown): Period {
  return v === 'week' || v === '7d' || v === '30d' || v === '90d' || v === 'month' ? (v as Period) : 'month'
}

// current = the period ending "now"; previous = the equal-length period right
// before it. 'month' uses calendar-month boundaries (UTC); the rolling periods
// use fixed-length windows back from now.
export function computePeriodWindows(period: Period, nowMs: number): PeriodWindows {
  const now = new Date(nowMs)
  if (period === 'month') {
    const curStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    const prevStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    return {
      current: { start: new Date(curStart).toISOString(), end: new Date(nowMs).toISOString() },
      previous: { start: new Date(prevStart).toISOString(), end: new Date(curStart).toISOString() },
    }
  }
  const days = period === '90d' ? 90 : period === '30d' ? 30 : 7 // 'week' | '7d' -> 7
  const len = days * DAY
  const curStart = nowMs - len
  const prevStart = curStart - len
  return {
    current: { start: new Date(curStart).toISOString(), end: new Date(nowMs).toISOString() },
    previous: { start: new Date(prevStart).toISOString(), end: new Date(curStart).toISOString() },
  }
}

// Percent change vs the previous value, rounded to 1 decimal. null when there's
// no baseline (previous === 0) — the frontend shows "new" rather than a bogus %.
export function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}
