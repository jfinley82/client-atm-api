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
  /**
   * @deprecated Accepted for compatibility, but NO LONGER shapes the captions.
   *
   * The Content Engine renders each of the 15 posts inside EVERY platform shell
   * the coach selects (LinkedIn / Instagram / Facebook), side by side, from ONE
   * generated caption — confirmed: same copy, different looks, not different
   * copy per platform. A caption written for one platform is therefore wrong in
   * the other two the moment it is displayed: "link in bio" means nothing on
   * LinkedIn, and LinkedIn's longer-form register reads as stiff on Instagram.
   *
   * Callers may keep sending this (a stale client, or the new multi-select
   * sending an array) and it is ignored rather than rejected — it cannot make
   * the output wrong, only fail to make it different.
   */
  platform?: unknown
  tone?: string
}

const ALLOWED_TONES = ['professional', 'casual', 'direct'] as const

// Tone is the one surviving content lever. Platform deliberately is not — see
// ContentIntake.platform. Defaults to direct when the member skips the intake.
export function resolveIntakeDefaults(intake: ContentIntake): { tone: string } {
  const tone = ALLOWED_TONES.includes(intake.tone as any) ? (intake.tone as string) : 'direct'
  return { tone }
}

const CONTENT_PROMPT = `You are an expert content strategist and copywriter helping a coach fill their content calendar using their own confirmed method and audience data — no writing required on their part.

You are given: the coach's named results FRAMEWORK (their actual method, phases, and language), their AUDIENCE data (who they help, the language that audience uses), their preferred tone, and — if available — their confirmed CORE OFFERS (for grounding calls to action in a real offer, not a vague one).

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "posts": [
    { "id": "p1", "category": "Authority", "caption": "a ready-to-post caption in the given tone, readable as-is on LinkedIn, Instagram AND Facebook. Short paragraphs separated by a blank line, never one solid block." }
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
- Write every caption/subject/body in the requested TONE.
- Write each caption as SHORT PARAGRAPHS of 1-3 sentences, each separated by a blank line (\\n\\n). Never one solid block. This is not optional formatting: the caption is rendered inside a real platform card, and a wall of text is what a reader scrolls past on every one of them.
- Every caption is PLATFORM-NEUTRAL and must read correctly, unedited, on LinkedIn, Instagram and Facebook — the coach picks which platforms to display, and the SAME caption is shown inside each one's native card side by side. So:
  - No platform-specific mechanics: no "link in bio", no "click the link below", no @ mentions or hashtag conventions that assume one app, no references to a feature only one platform has (Stories, Reels, connection requests).
  - Front-load the hook. Put the sharpest line first and make it stand alone, because the shorter platform shells visibly truncate — the first line has to earn the expand on its own.
  - Keep it in the middle register: not so long it reads as a LinkedIn essay, not so clipped it reads as a caption fragment. Write it so a reader on any of the three would not guess which platform it was written for.
  - Point to the coach's real offer or next step in plain words the reader can act on wherever they are.
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
  const { tone } = resolveIntakeDefaults(intake)

  const userMessage = `RESULTS FRAMEWORK: ${JSON.stringify(framework)}

AUDIENCE DATA: ${JSON.stringify(audience)}

CONFIRMED CORE OFFERS (may be null if not yet confirmed): ${JSON.stringify(coreOffers)}

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
