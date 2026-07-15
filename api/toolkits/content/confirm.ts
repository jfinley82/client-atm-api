import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../../lib/auth'
import { requireCapability } from '../../../lib/entitlements'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import { ContentAnalysis, ContentPost, ContentEmail } from '../../../lib/contentAnalysis'
import { stampSyncSnapshot } from '../../../lib/syncDependencies'
import { checkSyncGate } from '../../../lib/syncGate'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isValidPost(v: unknown): v is ContentPost {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return isNonEmptyString(p.id) && isNonEmptyString(p.category) && isNonEmptyString(p.caption)
}

function isValidEmail(v: unknown): v is ContentEmail {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return isNonEmptyString(e.id) && isNonEmptyString(e.type) && isNonEmptyString(e.subject) && isNonEmptyString(e.body)
}

// Explicit buy-in step. Body carries the full (possibly edited) posts/emails.
// Sets confirmed: true. Regenerating (a fresh POST /analyze) overwrites — no
// versioning for v1, per the Toolkits Architecture Reference Section 5b.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Capability gate — confirm/save is part of the toolkits capability (beta/full;
  // admin bypasses), closing the analyze-gated-but-confirm-open gap.
  if (!(await requireCapability(userId, 'toolkits', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { posts, emails } = body

  const valid =
    Array.isArray(posts) &&
    posts.length === 15 &&
    posts.every(isValidPost) &&
    Array.isArray(emails) &&
    emails.length === 5 &&
    emails.every(isValidEmail)

  if (!valid) {
    return res.status(400).json({
      error: 'Invalid confirm payload — expects exactly 15 posts ({id, category, caption}) and exactly 5 emails ({id, type, subject, body})',
    })
  }

  try {
    const existing = await getSavedOutput(userId, 'content')
    if (!existing) return res.status(404).json({ error: 'No content generated yet' })

    const syncGate = await checkSyncGate(userId, 'content')
    if (!syncGate.ok) {
      return res.status(409).json({ error: 'out_of_sync', blocking: syncGate.blocking, stale_items: syncGate.stale_items })
    }

    const sync_snapshot = await stampSyncSnapshot(userId, 'content')

    const updated: ContentAnalysis = {
      posts: posts as ContentPost[],
      emails: emails as ContentEmail[],
      confirmed: true,
      sync_snapshot,
    }

    await saveOutput(userId, 'content', updated)

    return res.status(200).json(updated)
  } catch (err) {
    console.error('[toolkits/content/confirm] POST', err)
    return res.status(500).json({ error: 'Confirm failed' })
  }
}
