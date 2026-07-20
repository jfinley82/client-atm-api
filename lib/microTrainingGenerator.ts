import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson, GenerationParseError } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// ── Unified Micro-Training generator ────────────────────────────────────────
// Produces the full Step 4 (Build) / Step 5 (Launch) asset set for ONE
// validated blueprint, grounded only in the coach's own Steps 1-3 data + their
// delivery choices. The full asset set is far too large for one Anthropic call
// to return inside maxDuration 60 (it would run ~2 min and/or truncate), so it
// is produced as SIX grouped calls that share one grounding block and run in
// parallel (the same pattern as the blueprint synopsis split). Each call logs
// its own cost. The per-asset units are also the reuse surface for the
// regenerate path (see regenerateAsset).

export type MtTopic = { title: string; angle: string; why: string }
export type MtOutlineItem = { section_number: number; title: string; description: string }
export type MtSlide = {
  slideNumber: number
  slideTitle: string
  script: string
  speakerNote: string
  timing: string
  sectionName: string
}
export type MtExercise = { prompt: string; lines: number }
export type MtWorkbookSection = { sectionTitle: string; keyInsight: string; exercises: MtExercise[]; reflection: string }
export type MtWorkbook = { title: string; intro: string; sections: MtWorkbookSection[]; keyTakeaways: string[] }
export type MtEmail = { email_number: number; send_timing: string; subject: string; body: string }
export type MtFacilitatorTip = { category: string; tip: string }

export type MicroTraining = {
  topics: MtTopic[]
  chosen_topic: string
  subtitle: string
  total_duration: string
  outline: MtOutlineItem[]
  slides: MtSlide[]
  workbook: MtWorkbook
  emails: MtEmail[]
  book_a_call_emails: MtEmail[]
  facilitator_tips: MtFacilitatorTip[]
}

export type DeliveryInput = {
  duration: '60' | '90' | '120'
  format: 'virtual' | 'in-person' | 'hybrid'
  facilitator_name: string
  soft_cta?: string
  call_page_url?: string
}

// The blueprint fields the generator is grounded in (same shape the toolkits use).
export type GeneratorCard = {
  id: string
  card_name: string
  problem_text: string
  reasoning: string
  suggested_offer: unknown
}

export type GeneratorInputs = {
  audience: unknown
  transformation: unknown
  framework: unknown
  card: GeneratorCard
  delivery: DeliveryInput
  voiceContext?: string
}

// The asset units. Each maps 1:1 to a persisted column group and is the unit the
// regenerate path re-runs individually.
export type AssetUnit = 'meta' | 'slides' | 'workbook' | 'facilitator_tips' | 'emails' | 'book_a_call'

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// ── Grounding ───────────────────────────────────────────────────────────────
// The identical block every unit call receives. delivery drives pacing + the
// CTA; the framework phases are the teaching arc / slide sectionNames.
function buildGrounding(inputs: GeneratorInputs): string {
  const d = inputs.delivery
  const ctaLine = d.soft_cta && d.soft_cta.trim().length > 0 ? d.soft_cta.trim() : '(none provided — write a soft, teaching-first CTA grounded in the blueprint suggested_offer)'
  const callUrl = d.call_page_url && d.call_page_url.trim().length > 0 ? d.call_page_url.trim() : '[BOOK_A_CALL_LINK]'
  return `AUDIENCE INTELLIGENCE: ${JSON.stringify(inputs.audience)}
TRANSFORMATION DATA: ${JSON.stringify(inputs.transformation)}
RESULTS FRAMEWORK (the teaching arc — use these phase names in order): ${JSON.stringify(inputs.framework)}
BLUEPRINT (the ONE problem/solution this training teaches):
- card_name: ${JSON.stringify(inputs.card.card_name)}
- problem_text: ${JSON.stringify(inputs.card.problem_text)}
- reasoning: ${JSON.stringify(inputs.card.reasoning)}
- suggested_offer: ${JSON.stringify(inputs.card.suggested_offer)}
DELIVERY:
- total run time: ${d.duration} minutes
- format: ${d.format}
- facilitator name: ${JSON.stringify(d.facilitator_name)}
- coach's soft CTA line: ${ctaLine}
- book-a-call link: ${callUrl}`
}

// Shared header + guardrails appended to every unit's system prompt.
const SHARED_RULES = `Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

Ground EVERYTHING in the specific data provided — the coach's real audience language, their transformation, their named framework phases, and this one blueprint's problem/solution/offer. No generic coaching-industry filler that could apply to any topic. The teaching arc must follow the coach's ACTUAL framework phases in order, applied to this blueprint's problem — not a generic skeleton. The workshop timing frame is only for pacing: a short welcome (~5 minutes), teaching blocks scaled to the total run time, and a wrap-up (~5 minutes). Any call to action is soft and teaching-first: it references the blueprint's suggested_offer and invites the next step, never a hard pitch.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

// ── Per-unit prompts ────────────────────────────────────────────────────────
// Each unit's system prompt carries only its own schema + rules. max_tokens is
// sized per unit. On the full generate all six run in parallel; regenerate runs
// exactly one.
type UnitSpec = { key: AssetUnit; maxTokens: number; prompt: string }

const UNIT_SPECS: Record<AssetUnit, UnitSpec> = {
  meta: {
    key: 'meta',
    maxTokens: 1500,
    prompt: `You design the framing for a coach's micro-training video. Produce the title options, the recommended primary title, a subtitle, the total run time, and a section outline.

{
  "topics": [ { "title": "title option", "angle": "the specific hook or framing", "why": "why this angle resonates with THIS audience" } ],
  "chosen_topic": "the ONE recommended primary title (may match one of the topics or be a sharper version of the strongest) — this is the working title",
  "subtitle": "a one-line subtitle that clarifies the promise",
  "total_duration": "the total run time as words, matching the delivery run time (e.g. '90 minutes')",
  "outline": [ { "section_number": 1, "title": "section title", "description": "one sentence on what this section covers" } ]
}

Rules:
- topics: exactly 5 distinct options, each grounded in this blueprint's problem and this audience's language.
- chosen_topic must never be empty — pick the strongest, sharpened for this audience.
- total_duration must reflect the delivery total run time given below.
- outline: the sections a viewer moves through, mapped to the framework's phases in order (welcome, the teaching phases, wrap-up + soft next step). One entry per section.
${SHARED_RULES}`,
  },
  slides: {
    key: 'slides',
    maxTokens: 6000,
    prompt: `You build the teaching slide deck the coach records the micro-training from. Each slide has the script the facilitator speaks, a short speaker note/cue, its timing, and the framework section it belongs to.

{
  "slides": [
    { "slideNumber": 1, "slideTitle": "slide title", "script": "what the facilitator actually says on this slide, written to be read or paraphrased on camera", "speakerNote": "a short delivery cue for this slide", "timing": "minutes for this slide, e.g. '5 min'", "sectionName": "the framework phase name this slide belongs to" }
  ]
}

Rules:
- Number slides 1..N in order. Scale the count to the delivery run time (roughly one slide per 4-6 minutes): about 10-12 slides for 60 minutes, 14-16 for 90, 18-22 for 120.
- The arc MUST follow the framework's ACTUAL phases in order: open with a welcome slide, move through the teaching phases applied to this blueprint's problem, and close with a wrap-up + a soft next-step slide.
- sectionName MUST be a real framework phase name (or "Welcome" / "Wrap-up" for the opening and closing slides).
- The per-slide timing values must sum to approximately the delivery total run time.
- script is the spoken content grounded in this blueprint and the audience's language — specific teaching, not vague restatements of the title.
- The final slide is a soft next-step slide referencing the blueprint's suggested_offer and the book-a-call link — teaching-first, no hard pitch.
${SHARED_RULES}`,
  },
  workbook: {
    key: 'workbook',
    maxTokens: 3500,
    prompt: `You build the participant workbook that accompanies the micro-training. It follows the same teaching arc and gives participants exercises and reflection space.

{
  "workbook": {
    "title": "workbook title",
    "intro": "a short intro paragraph orienting the participant",
    "sections": [
      { "sectionTitle": "section title (mapped to a framework phase)", "keyInsight": "the one key insight of this section", "exercises": [ { "prompt": "an exercise prompt the participant works through", "lines": 4 } ], "reflection": "a reflection question to close the section" }
    ],
    "keyTakeaways": ["a concrete takeaway", "another"]
  }
}

Rules:
- sections mirror the framework phases in order, same arc as the training.
- Each section has 1-3 exercises; "lines" is how many blank lines to leave for the answer (an integer 2-8).
- keyInsight, prompts, and reflection are specific to this blueprint's problem and this audience — no generic worksheet filler.
- keyTakeaways: 3-5 concrete takeaways a participant leaves with.
${SHARED_RULES}`,
  },
  facilitator_tips: {
    key: 'facilitator_tips',
    maxTokens: 1500,
    prompt: `You write delivery tips for the coach facilitating this micro-training, tuned to the delivery format (virtual, in-person, or hybrid).

{
  "facilitator_tips": [ { "category": "a short category label, e.g. 'Pacing' or 'Engagement'", "tip": "a specific, usable delivery tip for THIS training and format" } ]
}

Rules:
- 5-8 tips, each grounded in this specific training's arc and the delivery format given below.
- Tips must be concrete and usable, not generic public-speaking advice.
${SHARED_RULES}`,
  },
  emails: {
    key: 'emails',
    maxTokens: 2500,
    prompt: `You write the registration / pre-training email sequence (3 emails) that gets a registrant to actually show up and watch.

{
  "emails": [
    { "email_number": 1, "send_timing": "immediately after registration", "subject": "subject line", "body": "full email body — warm, direct, in the coach's voice. Confirm registration, remind them what they will learn and why it matters, end with the training link as [TRAINING_LINK]." },
    { "email_number": 2, "send_timing": "24 hours before / after registration", "subject": "subject line", "body": "reference the specific problem this training solves, build mild real urgency, end with [TRAINING_LINK]." },
    { "email_number": 3, "send_timing": "the day of / final reminder", "subject": "subject line", "body": "final nudge to attend, one clear reason to show up, end with [TRAINING_LINK]." }
  ]
}

Rules:
- Exactly 3 emails, grounded in this blueprint's problem and this audience's language, signed by the facilitator.
- These are PRE-training emails about attending — do not pitch the offer or a call here.
${SHARED_RULES}`,
  },
  book_a_call: {
    key: 'book_a_call',
    maxTokens: 2500,
    prompt: `You write the post-training booking email sequence (3 emails) that invites a viewer who watched the training to book a call, softly.

{
  "book_a_call_emails": [
    { "email_number": 1, "send_timing": "same day, after the training", "subject": "subject line", "body": "warm and personal. Reference what they just learned and the shift it created, soft invite to go deeper on a call, end with the booking link as [BOOK_A_CALL_LINK]." },
    { "email_number": 2, "send_timing": "2 days after", "subject": "subject line", "body": "name the single most common objection to booking and reframe it with empathy, point back to the result they want, end with [BOOK_A_CALL_LINK]." },
    { "email_number": 3, "send_timing": "4 days after", "subject": "subject line", "body": "final soft nudge. Clear, direct, no false scarcity, end with [BOOK_A_CALL_LINK]." }
  ]
}

Rules:
- Exactly 3 emails, grounded in this blueprint's problem/solution and its suggested_offer, signed by the facilitator.
- Soft and teaching-first — invite the call, never hard-sell.
${SHARED_RULES}`,
  },
}

// ── Coercers ────────────────────────────────────────────────────────────────
function coerceTopics(v: unknown): MtTopic[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => ({ title: asString(r.title), angle: asString(r.angle), why: asString(r.why) }))
    .filter((t) => t.title.trim().length > 0)
    .slice(0, 5)
}

function coerceOutline(v: unknown): MtOutlineItem[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r, i) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      const n = typeof o.section_number === 'number' && Number.isFinite(o.section_number) ? o.section_number : i + 1
      return { section_number: n, title: asString(o.title), description: asString(o.description) }
    })
    .filter((o) => o.title.trim().length > 0)
}

function coerceSlides(v: unknown): MtSlide[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r, i) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      const n = typeof o.slideNumber === 'number' && Number.isFinite(o.slideNumber) ? o.slideNumber : i + 1
      return {
        slideNumber: n,
        slideTitle: asString(o.slideTitle),
        script: asString(o.script),
        speakerNote: asString(o.speakerNote),
        timing: asString(o.timing),
        sectionName: asString(o.sectionName),
      }
    })
    .filter((s) => s.slideTitle.trim().length > 0 || s.script.trim().length > 0)
}

function coerceWorkbook(v: unknown): MtWorkbook {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const rawSections = Array.isArray(o.sections) ? o.sections : []
  const sections: MtWorkbookSection[] = rawSections
    .map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}))
    .map((s) => {
      const rawEx = Array.isArray(s.exercises) ? s.exercises : []
      const exercises: MtExercise[] = rawEx
        .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : {}))
        .map((e) => {
          const lines = typeof e.lines === 'number' && Number.isFinite(e.lines) ? Math.round(e.lines) : 4
          return { prompt: asString(e.prompt), lines: Math.min(12, Math.max(1, lines)) }
        })
        .filter((e) => e.prompt.trim().length > 0)
      return {
        sectionTitle: asString(s.sectionTitle),
        keyInsight: asString(s.keyInsight),
        exercises,
        reflection: asString(s.reflection),
      }
    })
    .filter((s) => s.sectionTitle.trim().length > 0)
  return {
    title: asString(o.title),
    intro: asString(o.intro),
    sections,
    keyTakeaways: asStringArray(o.keyTakeaways),
  }
}

function coerceEmails(v: unknown): MtEmail[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r, i) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      const n = typeof o.email_number === 'number' && Number.isFinite(o.email_number) ? o.email_number : i + 1
      return {
        email_number: n,
        send_timing: asString(o.send_timing),
        subject: asString(o.subject),
        body: asString(o.body),
      }
    })
    .filter((e) => e.subject.trim().length > 0 || e.body.trim().length > 0)
}

function coerceFacilitatorTips(v: unknown): MtFacilitatorTip[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => ({ category: asString(r.category), tip: asString(r.tip) }))
    .filter((t) => t.tip.trim().length > 0)
}

// ── Unit runner ─────────────────────────────────────────────────────────────
// Runs one unit's Anthropic call and returns the parsed partial. Throws
// GenerationParseError (from extractJson) on unparseable output, which callers
// map to 502 generation_truncated. Each call logs its own cost under 'generate'.
async function runUnit(
  userId: string,
  unit: AssetUnit,
  grounding: string,
  voiceContext?: string
): Promise<Partial<MicroTraining>> {
  const spec = UNIT_SPECS[unit]
  const system = voiceContext ? `${spec.prompt}\n\n${voiceContext}` : spec.prompt
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: spec.maxTokens,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: `${grounding}\n\nGenerate now.` }],
  })

  await logApiCost(userId, 'generate', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const parsed = extractJson(textBlock?.text ?? '')

  switch (unit) {
    case 'meta':
      return {
        topics: coerceTopics(parsed.topics),
        chosen_topic: asString(parsed.chosen_topic),
        subtitle: asString(parsed.subtitle),
        total_duration: asString(parsed.total_duration),
        outline: coerceOutline(parsed.outline),
      }
    case 'slides':
      return { slides: coerceSlides(parsed.slides) }
    case 'workbook':
      return { workbook: coerceWorkbook(parsed.workbook) }
    case 'facilitator_tips':
      return { facilitator_tips: coerceFacilitatorTips(parsed.facilitator_tips) }
    case 'emails':
      return { emails: coerceEmails(parsed.emails) }
    case 'book_a_call':
      return { book_a_call_emails: coerceEmails(parsed.book_a_call_emails) }
  }
}

// Full generate — all six units in parallel, merged into one MicroTraining.
// If any unit throws (including GenerationParseError), the whole generate fails
// so the caller returns an error rather than persisting a half-populated record.
export async function generateMicroTraining(userId: string, inputs: GeneratorInputs): Promise<MicroTraining> {
  const grounding = buildGrounding(inputs)
  const units: AssetUnit[] = ['meta', 'slides', 'workbook', 'facilitator_tips', 'emails', 'book_a_call']
  const parts = await Promise.all(units.map((u) => runUnit(userId, u, grounding, inputs.voiceContext)))
  const merged = Object.assign({}, ...parts) as Partial<MicroTraining>
  return {
    topics: merged.topics ?? [],
    chosen_topic: merged.chosen_topic ?? '',
    subtitle: merged.subtitle ?? '',
    total_duration: merged.total_duration ?? `${inputs.delivery.duration} minutes`,
    outline: merged.outline ?? [],
    slides: merged.slides ?? [],
    workbook: merged.workbook ?? { title: '', intro: '', sections: [], keyTakeaways: [] },
    emails: merged.emails ?? [],
    book_a_call_emails: merged.book_a_call_emails ?? [],
    facilitator_tips: merged.facilitator_tips ?? [],
  }
}

// Regenerate a single asset unit conditioned on the current chosen_topic. Used
// by the per-asset regenerate path; returns only that unit's partial.
export async function regenerateAsset(
  userId: string,
  unit: AssetUnit,
  inputs: GeneratorInputs,
  chosenTopic: string
): Promise<Partial<MicroTraining>> {
  const grounding = chosenTopic.trim().length > 0
    ? `${buildGrounding(inputs)}\nCURRENT TRAINING TITLE (align this asset to it): ${JSON.stringify(chosenTopic)}`
    : buildGrounding(inputs)
  return runUnit(userId, unit, grounding, inputs.voiceContext)
}

export { GenerationParseError }
