import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { loadBusinessSettings, isValidHttpUrl } from '../../lib/businessSettings'
import { AICoachGoal } from '../../lib/aiCoach'
import { resolveLeadSession } from '../../lib/aiCoachSession'

// GET /api/ai-coach/profile — lead-authed. Coach identity + bot identity + the
// two side actions, for the AI coach shell's header.
//
// The coach half is the SAME resolution the public funnel pages already use
// (api/funnels/render.ts): funnel_business_settings first, the owner's own
// profile as the fallback, so the bot's header and the coach's funnel show the
// same person rather than drifting apart.
export const config = { maxDuration: 30 }

// The bot's one-line tagline, derived from the coach's configured goal — this is
// the bot describing what it is FOR, so it follows the goal rather than being a
// separately-stored string that could contradict it. Lead-facing, so it is plain
// language with no internal or system terms.
const BOT_TAGLINE: Record<AICoachGoal, string> = {
  book_call: 'Ask me anything, and I can help you set up a call.',
  sell: 'Ask me anything, and I can point you to the right next step.',
  hybrid: 'Ask me anything, and I can help you work out what you need next.',
}

function firstUrl(...candidates: unknown[]): string | null {
  for (const c of candidates) if (isValidHttpUrl(c)) return (c as string).trim()
  return null
}

function trimmed(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const gate = await resolveLeadSession(req)
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error })
  const { session } = gate

  try {
    const [userRes, settings] = await Promise.all([
      // No `tagline` column exists on users — `profession` is the one-line
      // self-description the account already collects, so it fills that slot.
      supabase.from('users').select('name, avatar_url, bio, profession').eq('id', session.coachUserId).maybeSingle(),
      loadBusinessSettings(session.coachUserId),
    ])
    const user = (userRes.data || {}) as Record<string, unknown>

    // The workbook lives on the generation behind this lead's funnel.
    let guideUrl: string | null = null
    const generationId = session.funnel.generation_id
    if (typeof generationId === 'string' && generationId) {
      const { data: gen } = await supabase.from('mtm_generations').select('guide_url').eq('id', generationId).maybeSingle()
      guideUrl = firstUrl((gen as any)?.guide_url)
    }

    const goal = session.aiCoach.config.goal

    return res.status(200).json({
      coach: {
        // business_name is the brand the lead already saw on the funnel; the
        // coach's own name is the fallback, matching render.ts's chain.
        name: settings.business_name || trimmed(user.name) || 'Your coach',
        // Blank, not null, when the coach has no profession set — the header
        // renders this directly, so an empty line beats a null the frontend has
        // to guard. Never a stand-in phrase: an invented tagline would be words
        // the coach did not write appearing under their own name.
        tagline: trimmed(user.profession) ?? '',
        bio: trimmed(user.bio),
        photo: firstUrl(settings.headshot_url, user.avatar_url),
      },
      bot: {
        bot_name: session.aiCoach.bot_name || session.aiCoach.config.coach_bot_name,
        tagline: BOT_TAGLINE[goal] ?? BOT_TAGLINE.hybrid,
        goal,
      },
      actions: {
        video_url: firstUrl(session.funnel.video_url),
        guide_url: guideUrl,
      },
    })
  } catch (err) {
    console.error('[ai-coach/profile] GET', err)
    return res.status(500).json({ error: 'Failed to load profile' })
  }
}
