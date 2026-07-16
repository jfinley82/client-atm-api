import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'

// GET /api/admin/revenue — read-only revenue aggregation over purchases
// (status='active' rows only). amount_cents is the source of truth for
// revenue: summed directly, never re-derived from the product label — labels
// have history (older 'full' rows were the $27 offer; today low_ticket=$27
// and accelerator=$1497), so label-based math would silently rewrite the
// past. Rows with a NULL amount (the pre-Stripe GHL webhook path doesn't
// record one) count toward sale counts but contribute $0 to revenue.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

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

  try {
    const { data, error } = await supabase
      .from('purchases')
      .select('product, amount_cents, purchased_at, user:users(name, email)')
      .eq('status', 'active')

    if (error) throw error

    type Row = {
      product: string
      amount_cents: number | null
      purchased_at: string | null
      user: { name: string | null; email: string | null } | null
    }
    // Supabase types a joined relation as an array even when the FK makes it
    // a single row — normalize either shape to one object.
    const rows: Row[] = (data || []).map((r: any) => ({
      product: r.product,
      amount_cents: r.amount_cents,
      purchased_at: r.purchased_at,
      user: Array.isArray(r.user) ? (r.user[0] ?? null) : (r.user ?? null),
    }))

    let total_cents = 0
    const byProduct = new Map<string, { count: number; revenue_cents: number }>()

    // Last 12 calendar months (UTC), oldest first, zero-filled so the chart
    // axis is stable even in months with no sales.
    const now = new Date()
    const monthKeys: string[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      monthKeys.push(d.toISOString().slice(0, 7))
    }
    const byMonth = new Map<string, { revenue_cents: number; count: number }>(
      monthKeys.map((m) => [m, { revenue_cents: 0, count: 0 }])
    )

    for (const row of rows) {
      const cents = typeof row.amount_cents === 'number' ? row.amount_cents : 0
      total_cents += cents

      const p = byProduct.get(row.product) || { count: 0, revenue_cents: 0 }
      p.count += 1
      p.revenue_cents += cents
      byProduct.set(row.product, p)

      if (row.purchased_at) {
        const monthKey = row.purchased_at.slice(0, 7)
        const m = byMonth.get(monthKey)
        if (m) {
          m.revenue_cents += cents
          m.count += 1
        }
      }
    }

    const by_product = Array.from(byProduct.entries())
      .map(([product, v]) => ({ product, count: v.count, revenue_cents: v.revenue_cents }))
      .sort((a, b) => b.revenue_cents - a.revenue_cents)

    const by_month = monthKeys.map((month) => ({
      month,
      revenue_cents: byMonth.get(month)!.revenue_cents,
      count: byMonth.get(month)!.count,
    }))

    const recent = rows
      .filter((r) => r.purchased_at !== null)
      .sort((a, b) => (a.purchased_at! < b.purchased_at! ? 1 : -1))
      .slice(0, 20)
      .map((r) => ({
        date: r.purchased_at,
        product: r.product,
        amount_cents: r.amount_cents,
        member_name: r.user?.name ?? null,
        member_email: r.user?.email ?? null,
      }))

    return res.status(200).json({
      total_cents,
      total_count: rows.length,
      by_product,
      by_month,
      recent,
    })
  } catch (err) {
    console.error('[admin/revenue] GET', err)
    return res.status(500).json({ error: 'Failed to load revenue' })
  }
}
