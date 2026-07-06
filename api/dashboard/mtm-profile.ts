import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'

// GET /api/dashboard/mtm-profile
// Read-only aggregator for the dashboard's MTM Profile card. Pulls a few
// display fields from four already-built sources into one object. Each field is
// null until its source is complete/confirmed — the frontend keys off null to
// show a locked placeholder instead of real content. No writes, no new tables.
//
// Gating (verified against the live code, not assumed):
//   - audience:                content.completed === true  (isContentComplete)
//   - transformation_analysis: content.confirmed === true  (Part A /confirm)
//   - framework:               content.confirmed === true  (Part B /confirm)
//   - problem_solution_cards:  validated = true rows (matcher /finalize)

// A saved_outputs row's content as a plain object, or null if absent/non-object.
function contentObj(row: { content: unknown } | null): Record<string, unknown> | null {
  if (!row || !row.content || typeof row.content !== 'object' || Array.isArray(row.content)) return null
  return row.content as Record<string, unknown>
}

// Non-empty string, else null — a blank value is not real content, so it reads
// as locked (null) rather than rendering an empty unlocked card.
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const [audienceRow, analysisRow, frameworkRow, cardsResult] = await Promise.all([
      getSavedOutput(userId, 'audience'),
      getSavedOutput(userId, 'transformation_analysis'),
      getSavedOutput(userId, 'framework'),
      supabase
        .from('problem_solution_cards')
        .select('card_name')
        .eq('user_id', userId)
        .eq('validated', true)
        .order('created_at', { ascending: true })
        .limit(3),
    ])

    if (cardsResult.error) throw cardsResult.error

    // Audience — camelCase display fields ride along in saved content once the
    // session completes (see chat.ts deriveAudienceDisplayFields).
    const audience = contentObj(audienceRow)
    const audienceReady = !!audience && audience.completed === true
    const avatarName = audienceReady ? str(audience.avatarName) : null
    const problemStatement = audienceReady ? str(audience.problemStatement) : null

    // Transformation Part A — only expose once the member has confirmed a candidate.
    const analysis = contentObj(analysisRow)
    const zoneOfImpact = analysis && analysis.confirmed === true ? str(analysis.zoneOfImpact) : null

    // Transformation Part B (framework) — only expose once confirmed.
    const framework = contentObj(frameworkRow)
    const frameworkReady = !!framework && framework.confirmed === true
    const frameworkName = frameworkReady ? str(framework.frameworkName) : null
    const frameworkTagline = frameworkReady ? str(framework.frameworkTagline) : null

    // Validated problem/solution cards — up to 3 card names, empty array if none.
    const cardRows = (cardsResult.data || []) as Array<{ card_name: unknown }>
    const blueprintTopics = cardRows
      .map((c: { card_name: unknown }) => str(c.card_name))
      .filter((name: string | null): name is string => name !== null)

    return res.status(200).json({
      zoneOfImpact,
      avatarName,
      problemStatement,
      frameworkName,
      frameworkTagline,
      blueprintTopics,
    })
  } catch (err) {
    console.error('[dashboard/mtm-profile] GET', err)
    return res.status(500).json({ error: 'Failed to load MTM profile' })
  }
}
