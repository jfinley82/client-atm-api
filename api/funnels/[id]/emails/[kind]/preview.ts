import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../../../lib/supabase'
import { setCors, noStore } from '../../../../../lib/cors'
import { requireFunnelBuilder, getOwnedFunnel } from '../../../../../lib/funnels'

// GET /api/funnels/[id]/emails/[kind]/preview — read-only { subject, body } for
// the SYSTEM email kinds, which the Emails tab can otherwise never show.
//
// nurture_* and book_a_call_* are deliberately NOT served here: their content
// already lives on the funnel (nurture_emails / book_a_call_emails) and the tab
// previews them from there. Serving them twice would give the UI two sources
// that could disagree after an edit.
//
// The three kinds split by where their content actually comes from:
//
//   booking_confirmation / reminder_1w / reminder_3d / reminder_24h / reminder_1h
//     Fixed product templates, composed inline by lib/email.ts and
//     lib/funnelNurture.ts at send time out of runtime values (the lead's name,
//     the call time, the join link). There is no stored copy to read, so the
//     body here is a plain-text rendition of that same copy with the runtime
//     values as [TOKENS] — matching how the editable kinds render tokens. The
//     SUBJECTS are the literal strings those senders pass to Resend, so a
//     preview can't drift from what actually lands in an inbox.
//
//   post_call_1..3
//     NOT a fixed template: the coach's own funnel_launch_assets row
//     (asset_type 'post_call_emails'). Read it and return the real content, so
//     this preview shows what that coach will actually send. POST_CALL_SUBJECTS
//     mirrors the sender's own fallbacks for an email whose subject is blank.
//
// Preview only — nothing here composes or sends mail, and the senders are
// untouched.
export const config = { maxDuration: 15 }

type Preview = { subject: string; body: string }

const MANAGE_LINE = 'Need to change your time? You can reschedule or cancel here: [MANAGE_LINK]'

const FIXED_TEMPLATES: Record<string, Preview> = {
  booking_confirmation: {
    subject: 'Your call is booked',
    body: [
      'Hey [FIRST_NAME],',
      '',
      "You're all set. Here are the details:",
      '',
      '[CALL_TIME]',
      '',
      'Join the call: [JOIN_LINK]',
      '',
      'The attached calendar file will add this to your calendar.',
      '',
      MANAGE_LINE,
    ].join('\n'),
  },
  reminder_1w: {
    subject: 'Your call is next week',
    body: [
      'A quick reminder about your call:',
      '',
      '[CALL_TIME]',
      '',
      'Join the call: [JOIN_LINK]',
      '',
      MANAGE_LINE,
    ].join('\n'),
  },
  reminder_3d: {
    subject: 'Your call is in 3 days',
    body: [
      'A quick reminder about your call:',
      '',
      '[CALL_TIME]',
      '',
      'Join the call: [JOIN_LINK]',
      '',
      MANAGE_LINE,
    ].join('\n'),
  },
  reminder_24h: {
    subject: 'Your call is tomorrow',
    body: [
      'A quick reminder about your call:',
      '',
      '[CALL_TIME]',
      '',
      'Join the call: [JOIN_LINK]',
      '',
      MANAGE_LINE,
    ].join('\n'),
  },
  reminder_1h: {
    subject: 'Your call is in 1 hour',
    body: [
      'A quick reminder about your call:',
      '',
      '[CALL_TIME]',
      '',
      'Join the call: [JOIN_LINK]',
      '',
      MANAGE_LINE,
    ].join('\n'),
  },
}

// Mirrors POST_CALL_SUBJECTS in lib/funnelNurture.ts — the subject a post-call
// email falls back to when the coach's asset leaves it blank.
const POST_CALL_SUBJECTS = [
  'Great speaking with you',
  'Following up on our call',
  'Still here when you are',
]

const POST_CALL_KINDS = new Set(['post_call_1', 'post_call_2', 'post_call_3'])

/** The coach's post-call asset, in stored order. Empty when never built. */
async function loadPostCall(funnelId: string, index: number): Promise<Preview> {
  const { data: asset } = await supabase
    .from('funnel_launch_assets')
    .select('content')
    .eq('funnel_id', funnelId)
    .eq('asset_type', 'post_call_emails')
    .maybeSingle()

  const raw = (asset?.content as { emails?: unknown } | null)?.emails
  const emails = Array.isArray(raw) ? raw : []
  const item = emails[index] as Record<string, unknown> | undefined

  const subject = typeof item?.subject === 'string' ? item.subject.trim() : ''
  const body = typeof item?.body === 'string' ? item.body : ''

  return {
    subject: subject || POST_CALL_SUBJECTS[index] || POST_CALL_SUBJECTS[POST_CALL_SUBJECTS.length - 1],
    // No asset yet is a legitimate state, not an error: the sender is a silent
    // no-op in that case, and the tab should say so rather than 404.
    body: body || 'This coach hasn’t built their post-call emails yet, so nothing sends here.',
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireFunnelBuilder(req, res)
  if (!userId) return

  const id = req.query.id as string
  const kind = req.query.kind as string
  if (!id || !kind) return res.status(400).json({ error: 'id and kind required' })

  // Ownership first — 404 rather than leak that a funnel exists.
  const funnel = await getOwnedFunnel(userId, id, 'id, user_id')
  if (!funnel) return res.status(404).json({ error: 'Funnel not found' })

  const fixed = FIXED_TEMPLATES[kind]
  if (fixed) return res.status(200).json(fixed)

  if (POST_CALL_KINDS.has(kind)) {
    const index = Number(kind.slice('post_call_'.length)) - 1
    try {
      return res.status(200).json(await loadPostCall(id, index))
    } catch (err) {
      console.error('[funnels/[id]/emails/[kind]/preview] post_call', err)
      return res.status(500).json({ error: 'Failed to load preview' })
    }
  }

  return res.status(404).json({
    error: 'no_preview',
    message:
      'Only system emails preview here. nurture_* and book_a_call_* are stored on the funnel and preview from there.',
  })
}
