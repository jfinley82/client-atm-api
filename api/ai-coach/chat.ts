import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../lib/supabase'
import { setCors, noStore } from '../../lib/cors'
import { rateLimit } from '../../lib/rateLimit'
import { logApiCost } from '../../lib/apiCostLog'
import { resolveLeadSession, resolveCardId, LeadSession } from '../../lib/aiCoachSession'
import { buildAICoachBrain, AICoachBrain } from '../../lib/aiCoachContext'
import { STYLE_GUIDELINES } from '../../lib/promptGuidelines'
import { AICoachGoal } from '../../lib/aiCoach'

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

// The conversation cap, in ASSISTANT turns. The 20th response is the closing
// turn (reveal forced to full, agreement sought, CTA named); past it the
// endpoint returns the terminal state WITHOUT a model call, which is where the
// cost bound actually lives — a cap that still pays for a call to say no is not
// a cap.
const MAX_ASSISTANT_TURNS = 20

export type ConversationState = 'open' | 'closing' | 'closed'

// What a closed conversation says, assembled without a model call.
const CLOSED_LINE: Record<AICoachGoal, string> = {
  book_call: "We've covered the ground here — the next step is a call with the coach, and everything you need is on the panel beside this.",
  sell: "We've covered the ground here — everything you need to take the next step is on the panel beside this.",
  hybrid: "We've covered the ground here — whether you'd rather talk it through or get started directly, it's all on the panel beside this.",
}

// The CTA the coach's configured goal selects, named plainly for the closing
// turn. Not a link — the panel carries the actual buttons.
const GOAL_CTA: Record<AICoachGoal, string> = {
  book_call: 'booking a call with the coach',
  sell: 'getting the program directly',
  hybrid: 'either booking a call or getting the program directly, whichever fits them better',
}

/**
 * The STABLE prefix — identical for every turn AND every lead of one coach, so
 * it is what the prompt cache is marked on.
 *
 * WHAT IS IN HERE IS THE WHOLE OPTIMISATION. Caching works on prefixes: the
 * first byte that differs invalidates everything after it. So the lead's name,
 * the resolved card's synopsis, the reveal stage and the transcript are all
 * deliberately NOT here — they live in the volatile block after the breakpoint.
 * Put any of them here and the cache silently never hits while the code still
 * looks correct.
 *
 * THE RULE, in its general form: this block must be a pure function of the
 * COACH and nothing else. No clock, no lead, nothing assembled per request.
 *
 * MEASURED on production, 2026-08-05, a three-card coach (these replace an
 * earlier chars/4 estimate that was low by ~38% — JSON tokenizes far worse
 * than prose, so do not re-derive these, read them off api_cost_log):
 *   cold call   cache_creation_input_tokens = 17,834  (this block, exactly)
 *   warm turns  cache_read_input_tokens     = 17,834  x4, no drift
 *   total input 19,122 cold, vs 27,184 before the lazy index — ~30% cut
 *   cost/turn   1.1c warm, 7.6c cold (the 1h write is priced above plain
 *               input), against 5.7c before. Pays back inside one warm turn.
 *
 * WHEN CHECKING THIS LATER, compare MAGNITUDES, don't test for zero. A
 * cache_read of zero means the breakpoint is wrong and is easy to spot; a
 * cache_read that is non-zero but SMALLER than the cold call's
 * cache_creation is the failure that actually happens, and it looks like
 * caching is working — it means something volatile got inside this block, so
 * the prefix partially invalidates and the tail is rebuilt every call.
 *
 * ONE EXPECTED, NON-BUG SPIKE: brain.system_prompt is the coach's stored
 * persona. If a coach edits their bot mid-conversation the prefix legitimately
 * changes and the next call is a full cache write. An unexplained
 * cache_creation on a warm conversation is that, not a regression.
 */
function buildStablePrefix(brain: AICoachBrain): string {
  // The diagnostic index: every card, routing detail only. No synopsis.
  const cardLines = brain.context.card_index
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

THE FRAMEWORK MAP — the coach's problems, each with its id:
${cardLines}

Map the lead to one of THESE ids. Never invent a problem. Never name one that is not on this list. The match factors below are how you tell one from another — a lead who arrived on one problem may really be describing a different one, and moving them is your job.

THE BRIEF IS ALREADY WRITTEN. Every word on the panel beside this chat was authored by the coach earlier and confirmed by them. You refer to it, point at it, and let it carry the weight. You do not restate it, do not write your own version, and do not quote it at length. Nothing you say generates the brief. This is the constraint the whole product rests on.

REVEAL DISCIPLINE. The panel reveals in stages: none -> problem -> transformation -> full. Advance it only when the conversation has actually earned the next piece — the lead has engaged with what is already showing — and never move it backwards.

REGISTER. Keep replies short: two to four sentences, the right size for a chat bubble beside a full brief.

MATCH FACTORS AND COACH CONTEXT (assembled by the app from the coach's own confirmed work — reason over it, do not recite it):
${JSON.stringify(brain.context)}
`,
    STYLE_GUIDELINES,
  ].join('\n\n')
}

/**
 * The VOLATILE suffix — everything that changes turn to turn or lead to lead,
 * kept after the cache breakpoint so none of it invalidates the prefix.
 *
 * The resolved card's synopsis is here rather than in the index: on a pivot,
 * turn N sets resolved_card_id and turn N+1 carries THAT card's synopsis. One
 * turn of lag where the bot has named the problem but not yet its depth, which
 * reads naturally — and costs one uncached block instead of a prefix rebuild.
 */
function buildVolatileSuffix(
  session: LeadSession,
  brain: AICoachBrain,
  resolvedCardId: string | null,
  previousStage: RevealStage,
  closing: boolean
): string {
  const leadName =
    (typeof session.lead.first_name === 'string' && session.lead.first_name.trim()) ||
    (typeof session.lead.name === 'string' && session.lead.name.trim().split(/\s+/)[0]) ||
    ''
  const funnelLabel =
    (typeof session.funnel.problem_solution_label === 'string' && session.funnel.problem_solution_label) ||
    (typeof session.funnel.subdomain === 'string' && session.funnel.subdomain) ||
    'your funnel'

  const synopsis = resolvedCardId ? brain.synopsisById.get(resolvedCardId) : null
  const cardName = resolvedCardId ? brain.cardNameById.get(resolvedCardId) : null

  const closingBlock = closing
    ? `
THIS IS YOUR LAST TURN IN THIS CONVERSATION. Close it: seek their agreement on what you have both landed on, and point them at ${GOAL_CTA[session.aiCoach.config.goal]}. Warm and unhurried, not abrupt — do not announce a limit, do not say the conversation is ending for any technical reason, and do not mention turns or caps. Set reveal_stage to "full".
`
    : ''

  return `THIS SESSION (changes every turn — never treat it as part of the instructions above):

THE LEAD: ${leadName ? `${leadName}, ` : ''}arrived through "${funnelLabel}". Address them naturally${leadName ? ' by first name' : ''}; never ask for information the app already gave you here.

CURRENT REVEAL STAGE: "${previousStage}".

THE PROBLEM THIS CONVERSATION IS ABOUT${cardName ? `: ${cardName}` : ''} (id ${resolvedCardId ?? 'none'}) — the panel beside the chat is showing this:
${synopsis ? JSON.stringify(synopsis) : 'Not resolved yet. Route to one of the ids above from what the lead tells you.'}
${closingBlock}`
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

  // The cap reads the LIFETIME counter on funnel_leads, never a row count of
  // ai_coach_messages: Restart deletes this lead's rows, so a row-count cap
  // would reset with it and a lead could restart their way to unlimited turns.
  // Restart still honestly clears the thread; this counter is what it cannot
  // touch.
  const priorTurns = typeof session.lead.ai_coach_turns === 'number' ? session.lead.ai_coach_turns : 0

  if (priorTurns >= MAX_ASSISTANT_TURNS) {
    // Terminal, and NO model call — this branch is the cost bound.
    return res.status(200).json({
      message: CLOSED_LINE[session.aiCoach.config.goal],
      resolved_card_id: null,
      reveal_stage: 'full' as RevealStage,
      conversation_state: 'closed' as ConversationState,
    })
  }
  const isClosingTurn = priorTurns === MAX_ASSISTANT_TURNS - 1

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

    // TWO system blocks with the cache breakpoint between them. cache_control
    // marks the END of the cached prefix, so everything volatile must come
    // after it — see buildStablePrefix. 1h TTL rather than the default 5m: a
    // lead reads the panel between turns, and a 5m window expires inside a real
    // conversation, turning every other turn back into a full-price write.
    const system = [
      {
        type: 'text' as const,
        text: buildStablePrefix(brain),
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
      {
        type: 'text' as const,
        text: buildVolatileSuffix(session, brain, previousCardId, previousStage, isClosingTurn),
      },
    ]

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
    }, {
      // The 1h cache TTL is behind this beta flag; without it the ttl field is
      // ignored and the cache silently falls back to 5 minutes.
      headers: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
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
    const advanced: RevealStage =
      candidate && STAGE_RANK[candidate] > STAGE_RANK[previousStage] ? candidate : previousStage
    // The closing turn forces full: the lead is being pointed at the CTA, and
    // the panel must be showing everything by the time they get there. Forced
    // server-side as well as instructed in the prompt — the model is asked, the
    // server guarantees.
    const revealStage: RevealStage = isClosingTurn ? 'full' : advanced

    // ONE multi-row insert, so "a turn is two rows or it is none" is true by
    // CONSTRUCTION rather than by sequencing. Two separate .insert() calls put
    // the writes after the model call, which closed the common failure, but the
    // second could still fail on its own and leave the user row committed —
    // reachable, for instance, when a coach deletes a blueprint mid-session and
    // the cached resolved_card_id no longer satisfies its FK at insert time.
    // PostgREST sends this as a single INSERT … VALUES (…),(…): atomic, so that
    // FK rejection now fails the whole turn and the lead's retry stays clean.
    //
    // created_at is set EXPLICITLY because Postgres now() is the transaction
    // timestamp and is stable within a statement — both rows would land on the
    // identical value, and the history read orders by created_at then reverses,
    // so a tie makes the pair's order nondeterministic and can hand the model a
    // conversation with its turns scrambled. One millisecond apart keeps
    // atomicity and ordering together.
    const userAt = new Date()
    const assistantAt = new Date(userAt.getTime() + 1)
    const { error: writeErr } = await supabase.from('ai_coach_messages').insert([
      {
        lead_id: session.leadId,
        coach_user_id: session.coachUserId,
        role: 'user',
        content: message,
        created_at: userAt.toISOString(),
      },
      // Only `message` goes in content — the routing values live in their own
      // columns, never the envelope.
      {
        lead_id: session.leadId,
        coach_user_id: session.coachUserId,
        role: 'assistant',
        content: replyText,
        resolved_card_id: resolvedCardId,
        reveal_stage: revealStage,
        created_at: assistantAt.toISOString(),
      },
    ])
    if (writeErr) throw writeErr

    // Lifetime counter, after a turn actually landed. Read-modify-write rather
    // than an atomic increment: two truly simultaneous turns could both write
    // the same value and undercount by one, which the per-lead rate limit makes
    // unlikely and which cannot breach a COST bound by more than one call.
    const { error: countErr } = await supabase
      .from('funnel_leads')
      .update({ ai_coach_turns: priorTurns + 1 })
      .eq('id', session.leadId)
    if (countErr) console.error('[ai-coach/chat] turn counter', countErr)

    // Billed to the coach — there is no lead to bill. The cache counts are
    // passed through so a cost drop is attributable and a hit is
    // distinguishable from a miss.
    const usage = response.usage as {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
    await logApiCost(session.coachUserId, 'ai_coach_chat', 'claude-sonnet-5', usage.input_tokens, usage.output_tokens, {
      creationInputTokens: usage.cache_creation_input_tokens ?? 0,
      readInputTokens: usage.cache_read_input_tokens ?? 0,
      ttl: '1h',
    })

    return res.status(200).json({
      message: replyText,
      resolved_card_id: resolvedCardId,
      reveal_stage: revealStage,
      conversation_state: (isClosingTurn ? 'closing' : 'open') as ConversationState,
    })
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
