import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getVoiceContext } from '../../lib/voiceGuide'
import { getMemberSnapshot } from '../../lib/assistantContext'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// POST /api/assistant/chat — the in-app "MTM Coach" help assistant.
//
// An AI coach that knows the Micro-Training Method, the app, and the member's
// own progress and outputs. It answers in the SAME voice layer as every other
// AI tool and generated content: getVoiceContext(userId), which returns the
// member's captured voice guide plus the shared writing-style guide. That keeps
// the coach, the tools, and the content all sounding like one product.
//
// Body: { messages: [{ role: 'user' | 'assistant', content: string }] }
// Returns: { message: string }
//
// Read-only. It never writes to saved_outputs or changes member state.

const MAX_TURNS = 20 // trailing turns of history sent to the model
const MAX_CONTENT = 4000 // per-message character cap, defensive

const PERSONA = `You are the MTM Coach, the built-in assistant inside the Micro-Training Method app. You are an AI, not a person. If someone asks who you are, you are the app's AI coach, here to help them work through the method. Do not claim to be Jamaul or Danielle, and do not pretend to be human.

Your manner is a coach's: warm, direct, plain-spoken, encouraging, never fluffy. Keep replies short. Be specific. When the member is stuck, name the exact step or screen to go to next. When the member context below includes their own work, use it and refer to it by name. If the context does not include something, it is not done yet, so guide them toward doing it and never invent their avatar, framework, offers, or Blueprints.`

const METHOD_KNOWLEDGE = `THE MICRO-TRAINING METHOD
The method takes a coach from a fuzzy offer to a sellable micro-training in three steps, then into assets.
- Step 1 Attract: discover the audience at a deeper level. Name the avatar and find the gap, the space between what people think their problem is and what it actually is.
- Step 2 Transform: define the identity shift, map the results framework, and name the method.
- Step 3 Monetize: find the most sellable entry-point topics, validate up to three Micro-Blueprints, and set the core offers, a low-ticket and a high-ticket.
- Blueprint: generate the full Micro-Training Blueprint from the validated work.

THE APP
- Dashboard: home base. It shows progress and the next step.
- The MTM Method and Method Overview: the training and the map of the whole method.
- Step 1, Step 2, Step 3 screens: where the guided AI conversations happen.
- Micro-Blueprints and My Micro-Trainings: the member's saved outputs.
- Asset Creators: the four tools below.

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

type Msg = { role: 'user' | 'assistant'; content: string }

function sanitize(input: unknown): Msg[] {
  if (!Array.isArray(input)) return []
  const out: Msg[] = []
  for (const m of input) {
    if (!m || typeof m !== 'object') continue
    const role = (m as { role?: unknown }).role === 'assistant' ? 'assistant' : 'user'
    const rawContent = (m as { content?: unknown }).content
    const content = typeof rawContent === 'string' ? rawContent.trim().slice(0, MAX_CONTENT) : ''
    if (content) out.push({ role, content })
  }
  return out.slice(-MAX_TURNS)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const messages = sanitize(body.messages)
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'messages_required' })
    }

    // Same voice layer the AI tools use, plus this member's real situation.
    const [snapshot, voiceContext] = await Promise.all([getMemberSnapshot(userId), getVoiceContext(userId)])
    const system = buildSystem(snapshot.contextText, voiceContext)

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1200,
      thinking: { type: 'disabled' },
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    })

    const reply = completion.content[0]?.type === 'text' ? completion.content[0].text.trim() : ''
    return res.status(200).json({
      message: reply || "I'm here. Tell me what you're working on and I'll point you to the next move.",
    })
  } catch (err) {
    console.error('[assistant/chat] POST', err)
    return res.status(500).json({ error: 'The coach is unavailable right now' })
  }
}
