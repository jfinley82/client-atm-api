import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export const POST_CATEGORIES = ['Authority', 'Story', 'Problem-Aware', 'Offer/CTA', 'Engagement'] as const
export const EMAIL_TYPES = ['Welcome', 'Value', 'Soft Pitch', 'Hard Close', 'Retention'] as const
export const POSTS_PER_CATEGORY = 3

export type ContentPost = { id: string; category: string; caption: string }
export type ContentEmail = { id: string; type: string; subject: string; body: string }

export type ContentAnalysis = {
  posts: ContentPost[]
  emails: ContentEmail[]
  confirmed: boolean
  // Upstream dependency timestamps as of confirmation — see lib/syncDependencies.ts.
  sync_snapshot?: Record<string, string>
}

// Skippable 2-question intake, same short-intake pattern as Matcher's
// existing-offer check. Both optional; sensible defaults applied when absent
// (see resolveIntakeDefaults below) rather than gating on them.
export type ContentIntake = {
  platform?: string
  tone?: string
}

const ALLOWED_PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn', 'other'] as const
const ALLOWED_TONES = ['professional', 'casual', 'direct'] as const

// Defaults applied when the member skips the intake: platform-agnostic
// phrasing, direct tone.
export function resolveIntakeDefaults(intake: ContentIntake): { platform: string; tone: string } {
  const platform = ALLOWED_PLATFORMS.includes(intake.platform as any) ? (intake.platform as string) : 'platform-agnostic'
  const tone = ALLOWED_TONES.includes(intake.tone as any) ? (intake.tone as string) : 'direct'
  return { platform, tone }
}

const CONTENT_PROMPT = `You are an expert content strategist and copywriter helping a coach fill their content calendar using their own confirmed method and audience data — no writing required on their part.

You are given: the coach's named results FRAMEWORK (their actual method, phases, and language), their AUDIENCE data (who they help, the language that audience uses), their preferred platform and tone, and — if available — their confirmed CORE OFFERS (for grounding calls to action in a real offer, not a vague one).

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "posts": [
    { "id": "p1", "category": "Authority", "caption": "a ready-to-post caption, written for the given platform and tone" }
  ],
  "emails": [
    { "id": "e1", "type": "Welcome", "subject": "a specific, non-generic subject line", "body": "a full, ready-to-send email body" }
  ]
}

Rules:
- posts must have EXACTLY 15 entries: exactly 3 posts for EACH of these 5 categories, in this order: Authority, Story, Problem-Aware, Offer/CTA, Engagement. Number ids p1 through p15 sequentially in that same category order (p1-p3 = Authority, p4-p6 = Story, p7-p9 = Problem-Aware, p10-p12 = Offer/CTA, p13-p15 = Engagement).
  - Authority: demonstrates the coach's expertise/method, grounded in the framework.
  - Story: a real-feeling narrative angle drawn from the transformation/audience data — before/after, a client-style story, or the coach's own journey.
  - Problem-Aware: names a specific problem the audience has, in the audience's own language.
  - Offer/CTA: points toward working with the coach — ground the specific offer/CTA in the confirmed core offers if provided, otherwise a general "work with me" CTA.
  - Engagement: a question or prompt designed to start a conversation with the audience.
  - The 3 posts within each category must be genuinely distinct from each other — different angle, different specific detail, different opening line. Do not template or reuse the same sentence structure across posts.
- emails must have EXACTLY 5 entries, one per type, in this order: Welcome, Value, Soft Pitch, Hard Close, Retention. Number ids e1 through e5 in that order.
  - Welcome: introduces the coach and sets expectations for what this list is about.
  - Value: pure teaching, no pitch — a genuinely useful insight grounded in the framework.
  - Soft Pitch: introduces the offer gently, low pressure.
  - Hard Close: a direct, confident ask grounded in the confirmed core offer's real details if provided.
  - Retention: nurtures a subscriber who hasn't converted yet, keeps the relationship warm.
  - Each email's subject and body must be genuinely distinct in angle and content from the others — no reused openings or templated structure across the 5 emails.
- Write every caption/subject/body in the requested platform and tone. If platform is "platform-agnostic," avoid platform-specific formatting quirks (no platform-specific hashtag conventions, no @ mentions assuming a specific app).
- Ground every post and email in the SPECIFIC framework/audience data provided — never generic coaching-industry content that could apply to any coach.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export async function generateContent(
  userId: string,
  framework: unknown,
  audience: unknown,
  coreOffers: unknown,
  intake: ContentIntake,
  voiceContext?: string
): Promise<{ posts: ContentPost[]; emails: ContentEmail[] }> {
  const { platform, tone } = resolveIntakeDefaults(intake)

  const userMessage = `RESULTS FRAMEWORK: ${JSON.stringify(framework)}

AUDIENCE DATA: ${JSON.stringify(audience)}

CONFIRMED CORE OFFERS (may be null if not yet confirmed): ${JSON.stringify(coreOffers)}

PLATFORM: ${platform}
TONE: ${tone}

Generate the 15 posts and 5 emails now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${CONTENT_PROMPT}\n\n${voiceContext}` : CONTENT_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(userId, 'content', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  const parsed = extractJson(text)

  const posts: ContentPost[] = Array.isArray(parsed.posts)
    ? parsed.posts.map((p: any) => ({
        id: asString(p?.id),
        category: asString(p?.category),
        caption: asString(p?.caption),
      }))
    : []

  const emails: ContentEmail[] = Array.isArray(parsed.emails)
    ? parsed.emails.map((e: any) => ({
        id: asString(e?.id),
        type: asString(e?.type),
        subject: asString(e?.subject),
        body: asString(e?.body),
      }))
    : []

  return { posts, emails }
}
