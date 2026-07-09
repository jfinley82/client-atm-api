import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getVoiceContext } from '../../lib/voiceGuide'
import { getMemberSnapshot } from '../../lib/assistantContext'
import { getActiveHistory, appendMessages } from '../../lib/assistantHistory'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// POST /api/assistant/chat — the in-app "MTM Coach" help assistant.
//
// An AI coach that knows the Micro-Training Method, the app, and the member's
// own progress and outputs. It answers in the SAME voice layer as every other
// AI tool and generated content: getVoiceContext(userId), which returns the
// member's captured voice guide plus the shared writing-style guide. That keeps
// the coach, the tools, and the content all sounding like one product.
//
// Body: { message: string } — the member's new turn. Conversation history
// lives server-side (assistant_messages, via lib/assistantHistory) so the
// widget can restore it across reloads instead of holding it in memory.
// Legacy body shape { messages: [{ role, content }] } is also accepted: the
// last user-role entry is used as the new turn.
// Returns: { message: string }
//
// Not read-only: each exchange is appended to assistant_messages.
// saved_outputs and member progress are never touched.

const MAX_CONTENT = 4000 // per-message character cap, defensive

const PERSONA = `You are the MTM Coach, the built-in assistant inside the Micro-Training Method app. You are an AI, not a person. If someone asks who you are, you are the app's AI coach, here to help them work through the method. Do not claim to be Jamaul or Danielle, and do not pretend to be human.

Your manner is a coach's: warm, direct, plain-spoken, encouraging, never fluffy. Be specific. When the member is stuck, name the exact step or screen to go to next. When the member context below includes their own work, use it and refer to it by name. If the context does not include something specific, like a name, a price, or a title, treat it as not visible to you: say so plainly and point to the screen where it lives, without guessing where else it might be or suggesting something is broken. Never invent their avatar, framework, offers, or Blueprints.

Answer only what the member just asked, and answer it first — the first sentence of every reply must address their current message, not an earlier one. Do not open a reply with a status update about something from a previous question (an avatar name, the gap, anything else that isn't set yet) unless the CURRENT question is specifically about that exact thing. This applies even when the earlier topic feels related to the current one — a question about the AI Coach Builder does not need a reminder about the avatar name, and a question about the gap does not need a reminder about anything else. If a next-step nudge is genuinely relevant to what they just asked, put it in one line at the END of your reply, never the beginning, and never about a topic other than the one they asked about. Do not use the member's unfinished steps as a recurring theme you weave into unrelated answers — mention an unfinished step only when they ask about that specific thing or ask what to do next.

Reply length: 2-4 sentences for most answers. Only go longer when you're walking through concrete steps the member needs to follow one by one. If a reply needs more than 2-3 sentences, break it into short paragraphs with a blank line between them instead of one dense block, since members read these in a small chat widget.`

const METHOD_KNOWLEDGE = `THE MICRO-TRAINING METHOD
The method takes a coach from a fuzzy offer to a sellable micro-training in three steps, then into assets.
- Step 1 Attract: discover the audience at a deeper level. Name the avatar and find the gap, the space between what people think their problem is and what it actually is.
- Step 2 Transform: define the identity shift, map the results framework, and name the method.
- Step 3 Monetize: find the most sellable entry-point topics, validate up to three Micro-Blueprints, and set the core offers, a low-ticket and a high-ticket.
- Blueprint: generate the full Micro-Training Blueprint from the validated work.

THE APP
- Dashboard: home base. It shows progress and the next step.
- The MTM Method and Method Overview: the training and the map of the whole method.
- Step 1, Step 2, Step 3 screens: where the guided AI conversations happen. Core offers, the low-ticket and high-ticket, are set on the Step 3 screen.
- Micro-Blueprints: the member's validated Blueprint topics.
- My Micro-Trainings: the index of what's been built from those Blueprints, meaning the four Asset Creator outputs below. Core offers are never part of My Micro-Trainings.
- Asset Creators: the four tools below.

RULE: if asked about core offers specifically, point only to the Step 3 screen. Do not mention My Micro-Trainings in that answer, even as a second place to check.

THE ASSET CREATORS, each builds from the member's validated Blueprint
- Program Creator: turns the method into a full program outline.
- Content Creator: drafts posts and emails from the Blueprint.
- Micro-Training Creator: builds a full micro-training, the teaching deck and script, for one Blueprint.
- AI Coach Builder: builds a coaching bot the member can give to leads or sell as part of a low-ticket product. It generates a copy-paste system prompt for a Custom GPT or a Claude Project. The bot surfaces the lead's real problem and guides them to one of three paths: book a call, buy the low-ticket offer, or buy the coaching offer. To deploy it, the member pastes the prompt into a Custom GPT under the Configure tab in the Instructions box, or into a Claude Project's instructions, then shares the link or hands over the prompt.

COMMUNITY AND HELP
Members can ask questions in the community and join weekly office hours. For anything you cannot resolve, point them to the community, office hours, or Support.`

function buildSystem(contextText: string, voiceContext: string): string {
  return `${PERSONA}

${METHOD_KNOWLEDGE}

MEMBER CONTEXT, use only these facts for anything specific to this member, and treat anything absent as not done yet:
${contextText}

${voiceContext}`
}

// Pulls the member's new turn out of either body shape. Preferred: { message }.
// Legacy: { messages: [...] } — takes the last user-role entry and ignores
// the rest, since history now comes from the DB, not the client.
function extractNewTurn(body: Record<string, unknown>): string {
  if (typeof body.message === 'string') return body.message.trim().slice(0, MAX_CONTENT)
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i]
      if (!m || typeof m !== 'object') continue
      const role = (m as { role?: unknown }).role
      const content = (m as { content?: unknown }).content
      if (role === 'assistant') break // most recent turn wasn't from the member; nothing to answer
      if (role === 'user' && typeof content === 'string' && content.trim()) {
        return content.trim().slice(0, MAX_CONTENT)
      }
    }
  }
  return ''
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const newMessage = extractNewTurn(body)
    if (!newMessage) {
      return res.status(400).json({ error: 'message_required' })
    }

    // Same voice layer the AI tools use, plus this member's real situation,
    // plus their persisted conversation so far.
    const [snapshot, voiceContext, history] = await Promise.all([
      getMemberSnapshot(userId),
      getVoiceContext(userId),
      getActiveHistory(userId),
    ])
    const system = buildSystem(snapshot.contextText, voiceContext)
    const turns = [...history, { role: 'user' as const, content: newMessage }]

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1200,
      thinking: { type: 'disabled' },
      system,
      messages: turns.map((m) => ({ role: m.role, content: m.content })),
    })

    const reply =
      completion.content[0]?.type === 'text'
        ? completion.content[0].text.trim()
        : "I'm here. Tell me what you're working on and I'll point you to the next move."

    // Persist both sides of the exchange. Best-effort: if this write fails,
    // the member still gets their answer, they just lose this turn on reload.
    try {
      await appendMessages(userId, [
        { role: 'user', content: newMessage },
        { role: 'assistant', content: reply },
      ])
    } catch (persistErr) {
      console.error('[assistant/chat] history persist failed', persistErr)
    }

    return res.status(200).json({ message: reply })
  } catch (err) {
    console.error('[assistant/chat] POST', err)
    return res.status(500).json({ error: 'The coach is unavailable right now' })
  }
}
