import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type SlideEntry = {
  slide_number: number
  title: string
  speaker_notes: string
  key_points: string[]
}

// Per-card_id entry — see lib/toolkitsShared.ts's saveByCardIdEntry. This is
// the value type stored at content.by_card_id[card_id].
export type SlidesDeck = {
  training_title: string
  duration_estimate: string
  slides: SlideEntry[]
  confirmed: boolean
  // Upstream dependency timestamps as of confirmation — see lib/syncDependencies.ts.
  sync_snapshot?: Record<string, string>
}

const SLIDES_PROMPT = `You are an expert curriculum designer helping a coach turn one of their validated Micro-Blueprints into an actual teaching deck they can record a video from.

You are given: the coach's named results FRAMEWORK (the phases their method walks a client through — use this as the teaching arc), ONE specific validated Blueprint (a real problem/solution pairing this deck teaches), and the coach's AUDIENCE data (their voice and the language their audience uses).

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "training_title": "a specific, compelling title for THIS Blueprint's training — not generic",
  "duration_estimate": "a realistic estimate, e.g. '15-20 minutes'",
  "slides": [
    { "slide_number": 1, "title": "slide title", "speaker_notes": "what the coach actually says on this slide — written for them to read/paraphrase while recording", "key_points": ["a key point shown on the slide", "a second key point"] }
  ]
}

Rules:
- slides must have 10 to 12 entries, numbered 1 through the total in order.
- The teaching arc MUST follow the framework's ACTUAL phases in order, applied specifically to this Blueprint's problem — this is not a generic template, it is this coach's specific method applied to this specific problem. Reference the framework's real phase names where it helps the audience follow the structure.
- Ground every slide's content in the specific Blueprint (its problem_text/reasoning) and the audience's actual language — never generic teaching filler that could apply to any topic.
- key_points must have 2 to 4 entries per slide, concrete and specific, not vague restatements of the title.
- The FINAL slide must be a clear next-step/call-to-action slide that references the Blueprint's own suggested_offer (its name/price_point/format) if provided in the data — ground the CTA in that real offer. If no suggested_offer is provided, use a general "work with me" CTA without inventing offer details that weren't given.
- Do NOT generate any of the following — they are out of scope for this tool and belong to Funnel Builder instead: opt-in page copy, thank-you page copy, order page copy, or pre/post-VSL emails. Only generate the teaching slide deck itself.
- Ground everything in the specific data provided. No generic coaching-industry platitudes.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function coerceSlide(raw: unknown, fallbackNumber: number): SlideEntry {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const slide_number = typeof o.slide_number === 'number' && Number.isFinite(o.slide_number) ? o.slide_number : fallbackNumber
  return {
    slide_number,
    title: asString(o.title),
    speaker_notes: asString(o.speaker_notes),
    key_points: Array.isArray(o.key_points) ? o.key_points.filter((k: unknown): k is string => typeof k === 'string') : [],
  }
}

export async function generateSlides(
  userId: string,
  framework: unknown,
  selectedBlueprint: unknown,
  audience: unknown,
  voiceContext?: string
): Promise<Omit<SlidesDeck, 'confirmed'>> {
  const userMessage = `RESULTS FRAMEWORK: ${JSON.stringify(framework)}

SELECTED BLUEPRINT: ${JSON.stringify(selectedBlueprint)}

AUDIENCE DATA: ${JSON.stringify(audience)}

Generate the training slide deck now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 6000,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${SLIDES_PROMPT}\n\n${voiceContext}` : SLIDES_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  await logApiCost(userId, 'slides', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  const parsed = extractJson(text)

  const rawSlides = Array.isArray(parsed.slides) ? parsed.slides : []
  const slides = rawSlides.map((s: unknown, i: number) => coerceSlide(s, i + 1))

  return {
    training_title: asString(parsed.training_title),
    duration_estimate: asString(parsed.duration_estimate),
    slides,
  }
}
