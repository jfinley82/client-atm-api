import Anthropic from '@anthropic-ai/sdk'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type AICoachGoal = 'book_call' | 'sell' | 'hybrid'
export type AICoachPlatform = 'chatgpt' | 'claude'

// The coach's Build-studio configuration for their AI Coach.
export type AICoachConfig = {
  coach_bot_name: string
  card_ids: string[] // 1-2 of this user's validated blueprints
  goal: AICoachGoal
  disqualifying_questions: string[]
  platform: AICoachPlatform
}

// The stored + returned shape (saved_outputs tool_type 'ai_coach'). coach_name is
// backend-injected from users.name (never model-guessed); bot_name mirrors
// config.coach_bot_name.
export type AICoachContent = {
  config: AICoachConfig
  coach_name: string
  bot_name: string
  system_prompt: string
  deployment_instructions: string
  confirmed: boolean
  sync_snapshot?: Record<string, string>
}

// One blueprint the AI Coach knows, in full.
export type AICoachBlueprint = {
  card_name: string
  problem_text: string
  reasoning: string
  suggested_offer: unknown
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

const GOALS: AICoachGoal[] = ['book_call', 'sell', 'hybrid']
const PLATFORMS: AICoachPlatform[] = ['chatgpt', 'claude']

// Shape-only validation of the coach's config (no DB). generate additionally
// verifies each card_id is one of THIS user's validated blueprints.
export function validateAICoachConfig(raw: unknown): { ok: true; config: AICoachConfig } | { ok: false; error: string } {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const coach_bot_name = typeof c.coach_bot_name === 'string' ? c.coach_bot_name.trim() : ''
  if (!coach_bot_name) return { ok: false, error: 'coach_bot_name is required (non-empty string)' }
  if (!Array.isArray(c.card_ids) || c.card_ids.length < 1 || c.card_ids.length > 2 || !c.card_ids.every((x) => typeof x === 'string' && x.trim().length > 0)) {
    return { ok: false, error: 'card_ids must be 1-2 blueprint ids' }
  }
  if (!GOALS.includes(c.goal as AICoachGoal)) return { ok: false, error: "goal must be 'book_call', 'sell', or 'hybrid'" }
  if (!Array.isArray(c.disqualifying_questions) || !c.disqualifying_questions.every((x) => typeof x === 'string')) {
    return { ok: false, error: 'disqualifying_questions must be an array of strings' }
  }
  if (!PLATFORMS.includes(c.platform as AICoachPlatform)) return { ok: false, error: "platform must be 'chatgpt' or 'claude'" }
  return {
    ok: true,
    config: {
      coach_bot_name,
      card_ids: (c.card_ids as string[]).map((s) => s.trim()),
      goal: c.goal as AICoachGoal,
      disqualifying_questions: (c.disqualifying_questions as string[]).map((s) => s.trim()).filter((s) => s.length > 0),
      platform: c.platform as AICoachPlatform,
    },
  }
}

const AI_COACH_PROMPT = `You are building a paste-ready AI assistant persona (a "system prompt") that a coach will deploy as their OWN AI Coach on ChatGPT or Claude. This AI Coach is account-level: it knows the coach's whole process and both of their blueprints, speaks in the coach's voice, opens on the audience's real pain, screens leads, and steers qualified people toward the coach's goal.

You are given: the coach's name, the bot's name, their named results FRAMEWORK (its phases ARE the coach's process), 1-2 validated problem/solution BLUEPRINTS (real problems in the audience's own language), the AUDIENCE intelligence, the coach's confirmed CORE OFFERS (a low-ticket entry and a high-ticket premium, with real names + prices), the conversion GOAL, the DISQUALIFYING QUESTIONS, and the target PLATFORM.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "system_prompt": "the complete, paste-ready persona the coach pastes into ChatGPT/Claude",
  "deployment_instructions": "platform-specific paste steps"
}

Rules for system_prompt (this whole string IS the assistant's instructions — write it addressed to the assistant, e.g. "You are ..."):
- It introduces itself by the BOT NAME as the AI coach/assistant for COACH NAME. Use the real names.
- It knows the FRAMEWORK phases as the coach's actual process, and BOTH blueprints' real problem and solution in the audience's own language. It opens conversations on the specific pain the audience feels (drawn from the blueprints + audience data), not a generic greeting.
- It screens each lead by working the DISQUALIFYING QUESTIONS in naturally over the conversation — not a rigid form, but it does surface them and reads the answers.
- It steers a qualified lead toward the GOAL using the REAL offer details (names, prices, format):
  - book_call: guide them to book a call.
  - sell: guide them to the offer that fits (the low-ticket entry or the high-ticket premium), named with its real price.
  - hybrid: use judgment across booking a call, the low-ticket, and the high-ticket depending on fit and readiness.
- Include a short section titled "VOICE" INSIDE the system_prompt that tells the deployed bot how to sound — derived from the VOICE GUIDE provided below, so the bot keeps the coach's voice. Follow the coach's voice, including any specific word choices, over generic writing rules.
- Ground EVERYTHING in the real data provided — actual framework phase names, the real problems, the real offer names and prices. No vague placeholders like "[insert offer]" or "your framework".

Rules for deployment_instructions:
- Concrete, numbered paste steps for the target PLATFORM: for chatgpt, creating a custom GPT (name it the bot name, paste the system prompt into Instructions); for claude, creating a Project (paste the system prompt into the Project's custom instructions).
- End with a note to upload the context PDFs (the framework, the blueprints, and the offers) into the GPT/Project knowledge so the bot has the full detail to draw on.`

export async function generateAICoach(opts: {
  userId: string
  coach_name: string
  bot_name: string
  blueprints: AICoachBlueprint[]
  audience: unknown
  coreOffers: { low_ticket: unknown; high_ticket: unknown }
  framework: unknown
  goal: AICoachGoal
  disqualifying_questions: string[]
  platform: AICoachPlatform
  voiceContext: string
}): Promise<{ system_prompt: string; deployment_instructions: string }> {
  const userMessage = `COACH NAME: ${JSON.stringify(opts.coach_name)}
BOT NAME: ${JSON.stringify(opts.bot_name)}
RESULTS FRAMEWORK (its phases are the coach's process): ${JSON.stringify(opts.framework)}
BLUEPRINTS (1-2 real problem/solution pairs the coach teaches): ${JSON.stringify(opts.blueprints)}
AUDIENCE INTELLIGENCE: ${JSON.stringify(opts.audience)}
CORE OFFERS (real, confirmed):
- low_ticket (entry): ${JSON.stringify(opts.coreOffers.low_ticket)}
- high_ticket (premium): ${JSON.stringify(opts.coreOffers.high_ticket)}
GOAL: ${opts.goal}
DISQUALIFYING QUESTIONS (screen leads with these): ${JSON.stringify(opts.disqualifying_questions)}
PLATFORM: ${opts.platform}

Build the AI Coach now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 3500,
    thinking: { type: 'disabled' },
    system: `${AI_COACH_PROMPT}\n\n${opts.voiceContext}`,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(opts.userId, 'ai_coach', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const parsed = extractJson(textBlock?.text ?? '')

  return {
    system_prompt: asString(parsed.system_prompt),
    deployment_instructions: asString(parsed.deployment_instructions),
  }
}
