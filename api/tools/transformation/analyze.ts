import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { requireActiveUser } from '../../../lib/auth'
import { setCors } from '../../../lib/cors'
import { getSavedOutput, saveOutput } from '../../../lib/savedOutputs'
import { generateTransformationAnalysis, TransformationAnalysis } from '../../../lib/transformationAnalysis'

// GET: return the stored transformation analysis (404 if none generated yet).
// POST: generate a fresh analysis from the completed transformation
// conversation, persist it as a draft (confirmed: false), and return it.
// Requires saved_outputs('transformation') to exist.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  if (req.method === 'GET') {
    try {
      const saved = await getSavedOutput(userId, 'transformation_analysis')
      if (!saved) return res.status(404).json({ error: 'No analysis generated yet' })
      return res.status(200).json(saved.content)
    } catch (err) {
      console.error('[transformation/analyze] GET', err)
      return res.status(500).json({ error: 'Failed to load analysis' })
    }
  }

  if (req.method !== 'POST') return res.status(405).end()

  // Tier gate — AI generation requires a paid membership tier
  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  try {
    const transformationRow = await getSavedOutput(userId, 'transformation')
    if (!transformationRow) return res.status(400).json({ error: 'transformation_incomplete' })

    const generated = await generateTransformationAnalysis(transformationRow.content)

    if (generated.candidates.length !== 3) {
      console.error('[transformation/analyze] generation returned malformed output', {
        candidate_count: generated.candidates.length,
      })
      return res.status(502).json({ error: 'Analysis generation failed' })
    }

    const analysis: TransformationAnalysis = {
      ...generated,
      selected_id: null,
      confirmed: false,
    }

    await saveOutput(userId, 'transformation_analysis', analysis)

    return res.status(200).json(analysis)
  } catch (err) {
    console.error('[transformation/analyze] POST', err)
    return res.status(500).json({ error: 'Analysis failed' })
  }
}
