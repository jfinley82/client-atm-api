import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAdmin } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { createMember, normalizeMemberEmail, type CreateMemberResult } from '../../../lib/memberInvite'

// POST /api/admin/members/bulk — create many members from PARSED rows.
//
// Rows, not a file: parsing and preview belong in the browser, where an admin
// can see what each row will do and fix a typo before anything is written. An
// import that runs on click and reports afterwards is one that gets undone by
// hand.
//
// Two properties this endpoint owes its caller:
//
//  - IDEMPOTENT. Running the same list twice creates nothing the second time.
//    Every already-present address comes back as skipped_existing, so a retry
//    after a network failure is safe.
//  - PER ROW. One bad row never abandons the other thirty-nine. Someone
//    importing forty workshop attendees needs to know which three had typos,
//    not that "the import failed".
//
// The response is therefore always 200 with a result per row, INCLUDING when
// every row was rejected. A status code cannot express "37 created, 3 bad", and
// a 4xx would tell the browser to discard a body that is the entire point.

// A cap, so a pasted spreadsheet cannot become an unbounded write. Chosen well
// above a realistic workshop list; an admin with more splits the file.
const MAX_ROWS = 500

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireAdmin(req, res)
  if (!userId) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const rows = body.rows

  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'rows_required', message: 'rows must be an array of members' })
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'rows_required', message: 'rows is empty' })
  }
  if (rows.length > MAX_ROWS) {
    return res.status(400).json({
      error: 'too_many_rows',
      message: `rows must contain at most ${MAX_ROWS} entries; received ${rows.length}`,
    })
  }

  // `send_invite` is decided once for the whole import rather than per row —
  // an admin sending forty invites means it for all forty. Default ON, since a
  // member without a login is the failure this feature exists to prevent.
  const sendInvite = body.send_invite !== false

  const results: (CreateMemberResult & { index: number })[] = []
  // Within-payload duplicates are caught here rather than by the second row
  // hitting a row the first one just wrote. Both produce "already exists", but
  // only this one can say the collision was inside the file the admin uploaded.
  const seen = new Map<string, number>()

  for (let index = 0; index < rows.length; index++) {
    const raw = (rows[index] && typeof rows[index] === 'object' ? rows[index] : {}) as Record<string, unknown>

    const emailForDedupe = typeof raw.email === 'string' ? normalizeMemberEmail(raw.email) : ''
    if (emailForDedupe && seen.has(emailForDedupe)) {
      results.push({
        index,
        outcome: 'rejected',
        email: emailForDedupe,
        reason: 'duplicate_in_payload',
        message: `${emailForDedupe} also appears on row ${(seen.get(emailForDedupe) as number) + 1} of this import`,
      })
      continue
    }

    // Sequential on purpose. Concurrency here would race two rows carrying the
    // same address past the lookup in createMember, and the unique-index
    // recovery would then report a row as existing that this same import had
    // just written — true, but incomprehensible on screen. Forty rows is fast
    // enough that the trade is not worth making.
    const result = await createMember({
      name: raw.name,
      email: raw.email,
      membership_tier: raw.membership_tier,
      add_ons: raw.add_ons,
      send_invite: sendInvite,
    })

    if (emailForDedupe) seen.set(emailForDedupe, index)
    results.push({ index, ...result })
  }

  // Counts are DERIVED from the results, never tallied alongside them — a
  // summary that can disagree with the rows it summarises is a bug waiting to
  // be trusted.
  const summary = {
    total: results.length,
    created: results.filter((r) => r.outcome === 'created').length,
    skipped_existing: results.filter((r) => r.outcome === 'skipped_existing').length,
    rejected: results.filter((r) => r.outcome === 'rejected').length,
    invites_sent: results.filter((r) => r.outcome === 'created' && r.invite.sent).length,
  }

  return res.status(200).json({ summary, results })
}
