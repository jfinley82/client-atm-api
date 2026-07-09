import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// Per-card_id entry — see lib/toolkitsShared.ts's saveByCardIdEntry.
// coach_name is deliberately NOT part of the model's generation output (see
// generateQualifier below) — it's the account holder's real name (users.name),
// a known fact the model has no business guessing at, injected by the
// endpoint the same way suggested_starting_price/PHASE_COLORS/
// resolveFrameworkName/match_strength are backend-supplied rather than
// trusted to the model.
export type QualifierDeck = {
  coach_name: string
  system_prompt: string
  deployment_instructions: string
  confirmed: boolean
}

export type QualifierPlatform = 'chatgpt' | 'claude'

const QUALIFIER_PROMPT = `You are an expert conversation designer writing a system prompt for an AI lead-qualification assistant a coach will deploy on ChatGPT or Claude to engage their prospects.

You are given: the coach's own name (use it naturally, do not invent a different name), their AUDIENCE data (voice, language, and their signature "gap insight" — the felt problem beneath the surface problem), ONE specific validated Blueprint (a real problem/solution pairing this qualifier centers on), and their CONFIRMED CORE OFFERS — both a low_ticket and a high_ticket offer, in full real detail.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "system_prompt": "the full copy-paste system prompt/instructions block for the AI assistant to follow",
  "deployment_instructions": "short, platform-specific instructions for how the coach actually pastes this into the given platform to deploy it"
}

Rules for system_prompt:
- Write it as a complete, ready-to-use system prompt/persona instructions block — not a description OF a prompt, the actual prompt itself, ready to paste in verbatim.
- Persona: grounded in the audience's actual voice/language from the data provided. It should sound like how this coach and their audience actually talk, not a generic sales-bot register.
- Opens the conversation strategy by surfacing the SPECIFIC pain from the selected Blueprint's problem_text/reasoning — the same "AHA, someone named my problem better than I could" mechanic as this coach's own Gap Insight. Instruct the assistant to lead with this, not generic small talk.
- Explicitly instruct the assistant to use JUDGMENT as the conversation unfolds — not a rigid script — to steer toward exactly ONE of three real conversion paths based on what the conversation reveals: (1) book a call, (2) the low_ticket offer, or (3) the high_ticket offer. Describe concretely what signals in the conversation should point toward each path (e.g. urgency and budget constraints toward low_ticket, deeper commitment and readiness for full transformation toward high_ticket, ambivalence or complexity toward booking a call).
- All three paths must be described in the prompt using the REAL confirmed offer details provided (name, price_point, whats_included, delivery_format for both low_ticket and high_ticket) — never vague placeholders like "our program" or "a paid offer."
- system_prompt content must be platform-agnostic — it works identically whether pasted into ChatGPT or Claude. Do not reference either platform by name inside system_prompt itself.
- Ground everything in the specific data provided. No generic sales-bot platitudes.

Rules for deployment_instructions:
- Short, practical, platform-specific instructions for how the coach actually deploys this — e.g. pasting into a Custom GPT's instructions field vs. a Claude Project's custom instructions. This is the ONLY field that should differ based on the given platform; the system_prompt content itself must not change based on platform.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export async function generateQualifier(
  userId: string,
  coachName: string,
  audience: unknown,
  selectedBlueprint: unknown,
  coreOffers: unknown,
  platform: QualifierPlatform,
  voiceContext?: string
): Promise<{ system_prompt: string; deployment_instructions: string }> {
  const userMessage = `COACH'S NAME: ${coachName}

AUDIENCE DATA: ${JSON.stringify(audience)}

SELECTED BLUEPRINT: ${JSON.stringify(selectedBlueprint)}

CONFIRMED CORE OFFERS (low_ticket and high_ticket, both required): ${JSON.stringify(coreOffers)}

TARGET PLATFORM: ${platform}

Generate the system_prompt and deployment_instructions now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 3000,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${QUALIFIER_PROMPT}\n\n${voiceContext}` : QUALIFIER_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(userId, 'qualifier', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  const parsed = extractJson(text)

  return {
    system_prompt: asString(parsed.system_prompt),
    deployment_instructions: asString(parsed.deployment_instructions),
  }
}
