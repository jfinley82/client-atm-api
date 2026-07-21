import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { requireActiveUser } from '../../lib/auth'
import { requireCapability } from '../../lib/entitlements'
import { setCors } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'
import { logApiCost } from '../../lib/apiCostLog'
import { AICoachContent } from '../../lib/aiCoach'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// POST /api/ai-coach/preview { messages, system_prompt? } — ephemeral mock chat
// against the AI Coach persona. The persona is the body's system_prompt (a live
// edit) when non-empty, else the stored one. The persona is used VERBATIM as the
// system prompt — no MTM persona or voice layer is added, so the preview behaves
// exactly like the deployed bot. Persists nothing.
export const config = { maxDuration: 30 }

type PreviewMessage = { role: 'user' | 'assistant'; content: string }

function parseMessages(raw: unknown): PreviewMessage[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return null
  const out: PreviewMessage[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') return null
    const role = (m as Record<string, unknown>).role
    const content = (m as Record<string, unknown>).content
    if (role !== 'user' && role !== 'assistant') return null
    if (typeof content !== 'string' || content.trim().length === 0 || content.length > 4000) return null
    out.push({ role, content })
  }
  if (out[out.length - 1].role !== 'user') return null
  return out
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return
  if (!(await requireCapability(userId, 'toolkits', res))) return

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  const messages = parseMessages(body.messages)
  if (!messages) {
    return res.status(400).json({
      error: 'messages must be 1-20 turns of { role: "user"|"assistant", content } (each 1-4000 chars), ending with a user turn',
    })
  }

  try {
    let persona = typeof body.system_prompt === 'string' ? body.system_prompt.trim() : ''
    if (!persona) {
      const stored = (await getSavedOutput(userId, 'ai_coach'))?.content as AICoachContent | undefined
      persona = stored?.system_prompt?.trim() ?? ''
    }
    if (!persona) return res.status(404).json({ error: 'No AI Coach to preview — generate or pass a system_prompt' })

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      thinking: { type: 'disabled' },
      system: persona, // VERBATIM — the deployed persona only, no MTM layer added
      messages,
    })

    await logApiCost(userId, 'ai_coach_preview', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

    const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    return res.status(200).json({ message: textBlock?.text ?? '' })
  } catch (err) {
    console.error('[ai-coach/preview] POST', err)
    return res.status(500).json({ error: 'Preview failed' })
  }
}
