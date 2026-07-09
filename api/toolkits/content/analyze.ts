import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput, stripSessionHistory } from '../../../lib/savedOutputs'
import { generateContent, ContentAnalysis, ContentIntake } from '../../../lib/contentAnalysis'
import { checkAudienceComplete, checkFrameworkConfirmed } from '../../../lib/toolkitsShared'
import { CoreOffersAnalysis } from '../../../lib/coreOffersAnalysis'
import { getVoiceContext } from '../../../lib/voiceGuide'
import { GenerationParseError } from '../../../lib/aiJson'

// Toolkit: Content Creator (content). Generates a batch of social posts and
// nurture emails from the coach's confirmed Framework and Audience data.
//
// Gate: framework.confirmed AND audience.completed (both explicit — no
// transitive trust). core_offers is OPTIONAL context, used only if
// confirmed, never gated on — per the Toolkits Architecture Reference,
// Section 5b: "do not hard-gate on it."
//
// GET: return the stored content batch (404 if none generated yet).
// POST: generate a fresh batch. Body accepts an optional, skippable
// { platform, tone } intake — sensible defaults apply if omitted or invalid
// (see lib/contentAnalysis.ts resolveIntakeDefaults).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const saved = await getSavedOutput(userId, 'content')
      if (!saved) return res.status(404).json({ error: 'No content generated yet' })
      return res.status(200).json(saved.content)
    } catch (err) {
      console.error('[toolkits/content/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load content' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  try {
    const audienceGate = await checkAudienceComplete(userId)
    if (!audienceGate.ok) return res.status(400).json({ error: audienceGate.error })

    const frameworkGate = await checkFrameworkConfirmed(userId)
    if (!frameworkGate.ok) return res.status(400).json({ error: frameworkGate.error })

    const [audienceRow, coreOffersRow] = await Promise.all([
      getSavedOutput(userId, 'audience'),
      getSavedOutput(userId, 'core_offers'),
    ])

    const coreOffers = coreOffersRow?.content as CoreOffersAnalysis | undefined
    const confirmedCoreOffers = coreOffers?.confirmed === true ? coreOffers : null

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const intake: ContentIntake = {
      platform: typeof body.platform === 'string' ? body.platform : undefined,
      tone: typeof body.tone === 'string' ? body.tone : undefined,
    }

    const voiceContext = await getVoiceContext(userId)

    const frameworkContext = {
      frameworkName: frameworkGate.framework.frameworkName,
      frameworkTagline: frameworkGate.framework.frameworkTagline,
      phases: frameworkGate.framework.phases,
      descriptiveCopy: frameworkGate.framework.descriptiveCopy,
      audienceLanguage: frameworkGate.framework.audienceLanguage,
    }

    const { posts, emails } = await generateContent(
      userId,
      frameworkContext,
      stripSessionHistory(audienceRow!.content),
      confirmedCoreOffers,
      intake,
      voiceContext
    )

    if (posts.length !== 15 || emails.length !== 5) {
      console.error('[toolkits/content/analyze] generation returned malformed output', {
        posts_count: posts.length,
        emails_count: emails.length,
      })
      return res.status(502).json({ error: 'Content generation failed' })
    }

    const content: ContentAnalysis = { posts, emails, confirmed: false }

    await saveOutput(userId, 'content', content)

    return res.status(200).json(content)
  } catch (err) {
    if (err instanceof GenerationParseError) {
      console.error('[toolkits/content/analyze] POST generation_truncated', err.message, { rawTextLength: err.rawText.length })
      return res.status(502).json({ error: 'generation_truncated' })
    }
    console.error('[toolkits/content/analyze] POST', err)
    return res.status(500).json({ error: 'Content generation failed' })
  }
}
