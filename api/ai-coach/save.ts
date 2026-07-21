import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors } from '../../lib/cors'
import { supabase } from '../../lib/supabase'
import { getSavedOutput, saveOutput } from '../../lib/savedOutputs'
import { validateAICoachConfig, AICoachContent, AICoachConfig } from '../../lib/aiCoach'

// POST /api/ai-coach/save { system_prompt, deployment_instructions, config? } —
// save the coach's (possibly edited) AI Coach, confirmed: true. config is reused
// from the stored draft when omitted.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return
  if (!(await requireCapability(userId, 'toolkits', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  const system_prompt = typeof body.system_prompt === 'string' ? body.system_prompt.trim() : ''
  if (!system_prompt) return res.status(400).json({ error: 'system_prompt is required (non-empty string)' })

  try {
    const existing = (await getSavedOutput(userId, 'ai_coach'))?.content as AICoachContent | undefined

    // config comes from the body when re-editing it, else the stored draft's.
    let cfg: AICoachConfig
    if (body.config !== undefined) {
      const parsed = validateAICoachConfig(body.config)
      if (!parsed.ok) return res.status(400).json({ error: parsed.error })
      cfg = parsed.config
    } else if (existing?.config) {
      cfg = existing.config
    } else {
      return res.status(400).json({ error: 'No AI Coach config on file — generate first or pass config' })
    }

    const deployment_instructions =
      typeof body.deployment_instructions === 'string' ? body.deployment_instructions : existing?.deployment_instructions ?? ''

    const userRow = await supabase.from('users').select('name').eq('id', userId).maybeSingle()
    const coach_name = typeof userRow.data?.name === 'string' && userRow.data.name.trim().length > 0 ? userRow.data.name.trim() : 'the coach'

    const content: AICoachContent = {
      config: cfg,
      coach_name,
      bot_name: cfg.coach_bot_name,
      system_prompt,
      deployment_instructions,
      confirmed: true,
    }

    await saveOutput(userId, 'ai_coach', content)

    return res.status(200).json(content)
  } catch (err) {
    console.error('[ai-coach/save] POST', err)
    return res.status(500).json({ error: 'Failed to save AI Coach' })
  }
}
