import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { rateLimit } from '../../lib/rateLimit'
import { logApiCost } from '../../lib/apiCostLog'
import { resolveLeadSession, resolveCardId, LeadSession } from '../../lib/aiCoachSession'
import { buildAICoachBrain, AICoachBrain } from '../../lib/aiCoachContext'
import { STYLE_GUIDELINES } from '../../lib/promptGuidelines'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// POST /api/ai-coach/chat { message } — the hosted lead-facing chat turn.
// DELETE /api/ai-coach/chat — the shell's Restart control.
//
// THE TRANSCRIPT IS SERVER-OWNED. The client sends one string, never a
// `messages` array — the shell is a public unauthenticated page, and a client
// that could post its own assistant turns could rewrite what the coach's bot
// appears to have said, then screenshot it. preview.ts takes a client array
// because preview is authenticated as the coach and persists nothing. Chat is
// neither, so its history is loaded from ai_coach_messages and nothing else.
//
// Conversation pointer state (which problem, how much revealed) lives on the
// last assistant row — see migration 084. Serverless shares no memory and a
// lead can return weeks later on the same token; the transcript already
// survives both, so it carries the pointers too.
export const config = { maxDuration: 60 }

type RevealStage = 'none' | 'problem' | 'transformation' | 'full'
// The frontend agrees with these semantics exactly:
//   none            — panel sits on its intro state
//   problem         — audience_quote, solution_summary, cost_of_inaction, transformation.before
//   transformation  — adds transformation.after and objection_dissolved
//   full            — adds teaching_outline, the close block, and the closing CTAs
// The whole payload already ships from /synopsis in one response; the stage
// only governs what the frontend unhides. No extra round trips, no generation.
const STAGE_RANK: Record<RevealStage, number> = { none: 0, problem: 1, transformation: 2, full: 3 }
const asStage = (v: unknown): RevealStage | null =>
  v === 'none' || v === 'problem' || v === 'transformation' || v === 'full' ? v : null

// When the model returns an empty/absent message we still answer the lead —
// never 500 a turn over response shape.
const FALLBACK_LINE = 'Sorry, I lost my train of thought for a second. Could you say that again?'

const TURN_HISTORY_LIMIT = 30

function buildHostedSystemPrompt(session: LeadSession, brain: AICoachBrain, previousStage: RevealStage): string {
  const leadName =
    (typeof session.lead.first_name === 'string' && session.lead.first_name.trim()) ||
    (typeof session.lead.name === 'string' && session.lead.name.trim().split(/\s+/)[0]) ||
    ''
  const funnelLabel =
    (typeof session.funnel.problem_solution_label === 'string' && session.funnel.problem_solution_label) ||
    (typeof session.funnel.subdomain === 'string' && session.funnel.subdomain) ||
    'your funnel'

  // Every card as id | name | problem, the map the bot routes within.
  const cardLines = brain.context.cards
    .map((c) => `- id: ${c.id} | ${c.card_name} | ${c.problem_text}`)
    .join('\n')

  // Assembly order is deliberate: persona first (the coach's voice — nothing
  // below overrides it on wording), the hosted session layer second, the style
  // guide LAST. Same standing rule the email canonicals use: style guide and
  // coach voice win on wording, and where they disagree the coach's voice wins.
  return [
    brain.system_prompt,
    `
HOSTED SESSION LAYER (the app adds this; the persona above wins on wording):

THE LEAD: ${leadName ? `${leadName}, ` : ''}arrived through "${funnelLabel}". Address them naturally${leadName ? ' by first name' : ''}; never ask for information the app already gave you here.

THE FRAMEWORK MAP — the coach's problems, each with its id:
${cardLines}

Map the lead to one of THESE ids. Never invent a problem. Never name one that is not on this list. The match factors in the coach context below are how you tell one from another — a lead who arrived on one problem may really be describing a different one, and moving them is your job.

THE BRIEF IS ALREADY WRITTEN. Every word on the panel beside this chat was authored by the coach earlier and confirmed by them. You refer to it, point at it, and let it carry the weight. You do not restate it, do not write your own version, and do not quote it at length. Nothing you say generates the brief. This is the constraint the whole product rests on.

REVEAL DISCIPLINE. The panel reveals in stages: none -> problem -> transformation -> full. The stage is currently "${previousStage}". Advance it only when the conversation has actually earned the next piece — the lead has engaged with what is already showing — and never move it backwards.

REGISTER. Keep replies short: two to four sentences, the right size for a chat bubble beside a full brief.

COACH CONTEXT (assembled by the app from the coach's own confirmed work — reason over it, do not recite it):
${JSON.stringify(brain.context)}
`,
    STYLE_GUIDELINES,
  ].join('\n\n')
}

async function handleTurn(req: VercelRequest, res: VercelResponse, session: LeadSession) {
  if (!rateLimit(`ai_coach_chat:${session.leadId}`, 20, 60_000)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > 4000) {
    return res.status(400).json({ error: 'message must be 1-4000 characters' })
  }

  try {
    // This lead's last turns, newest first from the index, then reversed so the
    // model reads them oldest first.
    const { data: recent, error: readErr } = await supabase
      .from('ai_coach_messages')
      .select('role, content, resolved_card_id, reveal_stage')
      .eq('lead_id', session.leadId)
      .order('created_at', { ascending: false })
      .limit(TURN_HISTORY_LIMIT)
    if (readErr) throw readErr

    const turns = (recent || []).slice().reverse()

    // Previous pointers ride on the most recent assistant row. First turn ever:
    // the entry card and 'none'.
    const lastAssistant = (recent || []).find((r: any) => r.role === 'assistant') as
      | { resolved_card_id?: string | null; reveal_stage?: string | null }
      | undefined
    const previousCardId =
      (typeof lastAssistant?.resolved_card_id === 'string' && lastAssistant.resolved_card_id) ||
      (await resolveCardId(session))
    const previousStage: RevealStage = asStage(lastAssistant?.reveal_stage) ?? 'none'

    const brain = await buildAICoachBrain(session.coachUserId)
    const system = buildHostedSystemPrompt(session, brain, previousStage)

    // One call, not two: forced tool use brings the prose and the routing back
    // together.
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      thinking: { type: 'disabled' },
      system,
      messages: [
        ...turns.map((t: any) => ({ role: t.role as 'user' | 'assistant', content: String(t.content) })),
        { role: 'user' as const, content: message },
      ],
      tools: [
        {
          name: 'reply',
          description: 'Reply to the lead and route the session.',
          input_schema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'What the bot says to the lead.' },
              resolved_card_id: { type: 'string', description: "The id of the coach's problem this conversation is now about." },
              reveal_stage: { type: 'string', enum: ['none', 'problem', 'transformation', 'full'] },
            },
            required: ['message', 'resolved_card_id', 'reveal_stage'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'reply' },
    })

    // Response-shape tolerance: no tool block falls back to the first text
    // block and keeps BOTH previous pointers. A slightly stale panel is
    // recoverable; a broken conversation is not.
    const toolBlock = response.content.find((b) => b.type === 'tool_use') as
      | { type: 'tool_use'; input: Record<string, unknown> }
      | undefined
    const textBlock = response.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined

    let replyText = ''
    let returnedCardId: unknown = null
    let returnedStage: unknown = null
    if (toolBlock && toolBlock.input && typeof toolBlock.input === 'object') {
      replyText = typeof toolBlock.input.message === 'string' ? toolBlock.input.message.trim() : ''
      returnedCardId = toolBlock.input.resolved_card_id
      returnedStage = toolBlock.input.reveal_stage
    } else {
      replyText = textBlock?.text?.trim() ?? ''
    }
    if (!replyText) replyText = FALLBACK_LINE

    // CLAMPS — structural, on top of the prompt's instructions. Both, not
    // either.
    // Routing must stay inside the coach's own cards: anything else, including
    // a plausible-looking uuid, falls back to the previous value.
    const resolvedCardId =
      typeof returnedCardId === 'string' && brain.cardIds.has(returnedCardId) ? returnedCardId : previousCardId
    // The stage is monotonic: the panel unhides as it rises, and re-hiding
    // something the lead already read reads to them as the page breaking.
    const candidate = asStage(returnedStage)
    const revealStage: RevealStage =
      candidate && STAGE_RANK[candidate] > STAGE_RANK[previousStage] ? candidate : previousStage

    // Both rows AFTER the successful model call, user then assistant. A user
    // turn written first and orphaned by a failed call would sit in the
    // transcript forever, poison every later prompt, and make the lead's retry
    // a duplicate. Failing before any write keeps the retry clean.
    const { error: userErr } = await supabase.from('ai_coach_messages').insert({
      lead_id: session.leadId,
      coach_user_id: session.coachUserId,
      role: 'user',
      content: message,
    })
    if (userErr) throw userErr
    // Only `message` goes in content — the routing values live in their own
    // columns, never the envelope.
    const { error: asstErr } = await supabase.from('ai_coach_messages').insert({
      lead_id: session.leadId,
      coach_user_id: session.coachUserId,
      role: 'assistant',
      content: replyText,
      resolved_card_id: resolvedCardId,
      reveal_stage: revealStage,
    })
    if (asstErr) throw asstErr

    // Billed to the coach — there is no lead to bill.
    await logApiCost(session.coachUserId, 'ai_coach_chat', 'claude-sonnet-5', response.usage.input_tokens, response.usage.output_tokens)

    return res.status(200).json({ message: replyText, resolved_card_id: resolvedCardId, reveal_stage: revealStage })
  } catch (err) {
    console.error('[ai-coach/chat] POST', err)
    return res.status(500).json({ error: 'chat_failed' })
  }
}

// Restart. Without this the button clears the visible thread while the server
// still loads the old turns, and the bot carries on remembering a conversation
// the lead believes they ended. Lead-owned data, cascade-scoped to the lead.
async function handleRestart(res: VercelResponse, session: LeadSession) {
  try {
    const { error } = await supabase.from('ai_coach_messages').delete().eq('lead_id', session.leadId)
    if (error) throw error
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[ai-coach/chat] DELETE', err)
    return res.status(500).json({ error: 'restart_failed' })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).end()
  noStore(res)

  const result = await resolveLeadSession(req)
  // The gate's 404 is deliberately uniform — a lead must not learn anything
  // about the coach's account state from the error shape.
  if (!result.ok) return res.status(result.status).json({ error: result.error })

  if (req.method === 'DELETE') return handleRestart(res, result.session)
  return handleTurn(req, res, result.session)
}
