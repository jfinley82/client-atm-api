import type { VercelRequest, VercelResponse } from '@vercel/node'
import { setCors, noStore } from '../../lib/cors'
import { requireFunnelBuilder } from '../../lib/funnels'
import { contactsSummary, importContacts, parseContactsCsv } from '../../lib/coachContacts'

// GET  /api/contacts/import — the Emails tab's list header: how many contacts
//   this coach has and which file they last uploaded.
// POST /api/contacts/import — CSV in, validated + deduped into coach_contacts.
//
// Body: { csv, filename? } as JSON, or a raw text/csv body. Multipart is
// deliberately not accepted — it would mean a parser dependency for a single
// text field the browser can read with FileReader and post as a string.
//
// These are the COACH's own contacts, not funnel leads. Nothing here writes
// funnel_leads: an imported address never visited the funnel, and counting it
// as a lead would inflate visits and opt-in rate everywhere they are reported.
export const config = { maxDuration: 30 }

// Roughly 100k addresses. Large enough that no real coach list hits it, small
// enough that a pasted mistake can't exhaust the function's memory.
const MAX_CSV_BYTES = 5 * 1024 * 1024

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      return res.status(200).json(await contactsSummary(userId))
    } catch (err) {
      console.error('[contacts/import] GET', err)
      return res.status(500).json({ error: 'Failed to load contacts' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  const body = req.body
  let csv = ''
  let filename: string | null = null

  if (typeof body === 'string') {
    csv = body
  } else if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    csv = typeof b.csv === 'string' ? b.csv : ''
    filename = typeof b.filename === 'string' && b.filename.trim() ? b.filename.trim() : null
  }

  if (!csv.trim()) {
    return res.status(400).json({ error: 'csv required', message: 'Send the file contents as `csv`.' })
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    return res.status(400).json({ error: 'csv_too_large', message: 'That file is over 5MB.' })
  }

  try {
    const parsed = parseContactsCsv(csv)
    if (parsed.contacts.length === 0) {
      // An actionable 400, not a silent success: a file where nothing parsed is
      // almost always the wrong column or the wrong file.
      return res.status(400).json({
        error: 'no_contacts',
        message: 'No email addresses found in that file.',
        total: parsed.total,
        invalid: parsed.invalid,
      })
    }

    const result = await importContacts(userId, parsed, filename)
    return res.status(200).json({ ...result, summary: await contactsSummary(userId) })
  } catch (err) {
    console.error('[contacts/import] POST', err)
    return res.status(500).json({ error: 'Failed to import contacts' })
  }
}
