import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson, GenerationParseError } from './aiJson'
import { logApiCost } from './apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// ── Unified Micro-Training generator ────────────────────────────────────────
// Produces the full Step 4 (Build) / Step 5 (Launch) asset set for ONE
// validated blueprint, grounded only in the coach's own Steps 1-3 data + a few
// optional delivery details. The Micro-Training is a single 15-20 minute
// RECORDED teaching video (no live audience, no Q&A, no room pacing), about
// 10-12 slides. The full asset set is far too large for one Anthropic call to
// return inside maxDuration 60 (it would run ~2 min and/or truncate), so it is
// produced as SIX grouped calls that share one grounding block and run in
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
export type MtRecordingTip = { category: string; tip: string }

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
  recording_tips: MtRecordingTip[]
}

// The coach's own authorship material from the Build studio's guided prompts.
// Both optional; when present these are the coach's WORDS and are preserved,
// framed around, never paraphrased away.
export type PersonalHook = { opening_story?: string; signature_example?: string }
export type CtaType = 'book_call' | 'sell_program'

// The coach's optional recording + authorship inputs. No duration/format — the
// video is a fixed 15-20 minute recording. presenter_name defaults to the
// coach's account name when omitted (resolved by the endpoint). personal_hook +
// cta_type are the Build-studio authorship inputs, persisted in this same blob.
export type DeliveryInput = {
  presenter_name?: string
  call_page_url?: string
  // The coach's offer/checkout link — one generic field that accepts a checkout
  // URL or a sales/offer page. Used as the CTA target when cta_type is sell_program.
  sell_page_url?: string
  soft_cta?: string
  personal_hook?: PersonalHook
  cta_type?: CtaType
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
export type AssetUnit = 'meta' | 'slides' | 'workbook' | 'recording_tips' | 'emails' | 'book_a_call'

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// ── Grounding ───────────────────────────────────────────────────────────────
// The identical block every unit call receives. The framework phases are the
// recorded teaching arc / slide sectionNames; the optional presenter name + CTA
// are the only delivery details.
function buildGrounding(inputs: GeneratorInputs): string {
  const d = inputs.delivery
  const presenter = d.presenter_name && d.presenter_name.trim().length > 0 ? d.presenter_name.trim() : '(the coach)'
  const ctaLine = d.soft_cta && d.soft_cta.trim().length > 0 ? d.soft_cta.trim() : '(none provided — write a soft, teaching-first CTA grounded in the blueprint suggested_offer)'
  const callUrl = d.call_page_url && d.call_page_url.trim().length > 0 ? d.call_page_url.trim() : '[BOOK_A_CALL_LINK]'
  const sellUrl = d.sell_page_url && d.sell_page_url.trim().length > 0 ? d.sell_page_url.trim() : '[OFFER_LINK]'

  // The coach's own authorship inputs.
  const story = d.personal_hook?.opening_story?.trim()
  const example = d.personal_hook?.signature_example?.trim()
  const ctaType: CtaType = d.cta_type === 'sell_program' ? 'sell_program' : 'book_call'
  const storyLine = story
    ? `- COACH'S OWN OPENING STORY (their words — weave into the hook, preserve them, do not paraphrase them away): ${JSON.stringify(story)}`
    : `- COACH'S OWN OPENING STORY: (none provided — write a strong hook, do NOT fabricate a personal story)`
  const exampleLine = example
    ? `- COACH'S SIGNATURE EXAMPLE (their words — work into the teaching where it fits naturally, preserve them): ${JSON.stringify(example)}`
    : `- COACH'S SIGNATURE EXAMPLE: (none provided)`

  // The CTA toggle. Exactly ONE target link applies; the closing email sequence
  // and the closing slide use THAT link (written as the token below).
  const ctaBlock =
    ctaType === 'sell_program'
      ? `CTA:
- cta_type: sell_program — the closing invites buying the program directly.
- target link: use the token [OFFER_LINK] (resolves to ${sellUrl}) in the closing email sequence and the closing slide. Do NOT use the book-a-call link.`
      : `CTA:
- cta_type: book_call — the closing invites booking a call.
- target link: use the token [BOOK_A_CALL_LINK] (resolves to ${callUrl}) in the closing email sequence and the closing slide. Do NOT use the offer link.`

  return `AUDIENCE INTELLIGENCE: ${JSON.stringify(inputs.audience)}
TRANSFORMATION DATA: ${JSON.stringify(inputs.transformation)}
RESULTS FRAMEWORK (the recorded teaching arc — use these phase names in order): ${JSON.stringify(inputs.framework)}
BLUEPRINT (the ONE problem/solution this training teaches):
- card_name: ${JSON.stringify(inputs.card.card_name)}
- problem_text: ${JSON.stringify(inputs.card.problem_text)}
- reasoning: ${JSON.stringify(inputs.card.reasoning)}
- suggested_offer: ${JSON.stringify(inputs.card.suggested_offer)}
FORMAT: a single 15-20 minute pre-recorded teaching video the coach records solo on camera. No live audience, no Q&A.
AUTHORSHIP (the coach's own inputs — preserve their words, frame around them):
${storyLine}
${exampleLine}
${ctaBlock}
RECORDING DETAILS:
- presenter name (use when signing / referring to the coach): ${JSON.stringify(presenter)}
- coach's soft CTA line: ${ctaLine}`
}

// Shared header + guardrails appended to every unit's system prompt.
const SHARED_RULES = `Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

Ground EVERYTHING in the specific data provided — the coach's real audience language, their transformation, their named framework phases, and this one blueprint's problem/solution/offer. No generic coaching-industry filler that could apply to any topic. The teaching arc must follow the coach's ACTUAL framework phases in order, applied to this blueprint's problem — not a generic skeleton. This is ONE pre-recorded 15-20 minute teaching video, not a live session: no welcome-the-room, no housekeeping, no Q&A, no live-audience or workshop language. The arc is a recorded hook, then the framework applied to this problem, then the key insight, then a soft next step. Any call to action is soft and teaching-first: it references the blueprint's suggested_offer and invites the viewer to book a call, never a hard pitch.
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
    maxTokens: 2500,
    prompt: `You design the framing for a coach's pre-recorded micro-training video. Produce the title options, the recommended primary title, a subtitle, the run time, and a section outline.

{
  "topics": [ { "title": "title option", "angle": "the specific hook or framing", "why": "why this angle resonates with THIS audience" } ],
  "chosen_topic": "the ONE recommended primary title (may match one of the topics or be a sharper version of the strongest) — this is the working title",
  "subtitle": "a one-line subtitle that clarifies the promise",
  "total_duration": "the video run time in words — always in the 15-20 minute range (e.g. '15-20 minutes')",
  "outline": [ { "section_number": 1, "title": "section title", "description": "one sentence on what this section covers" } ]
}

Rules:
- topics: exactly 5 distinct options, each grounded in this blueprint's problem and this audience's language.
- chosen_topic must never be empty — pick the strongest, sharpened for this audience.
- total_duration is always a 15-20 minute recorded video — do not invent a longer run time.
- outline: the sections a viewer moves through in the recording, mapped to the framework's phases in order (hook, the teaching phases applied to this problem, the key insight, a soft next step). One entry per section.
${SHARED_RULES}`,
  },
  slides: {
    key: 'slides',
    maxTokens: 8000,
    prompt: `You build the slide deck the coach records the micro-training video from. Each slide has the script the coach speaks on camera, a short speaker note/cue, its timing, and the framework section it belongs to.

{
  "slides": [
    { "slideNumber": 1, "slideTitle": "slide title", "script": "what the coach actually says on this slide, written to be read or paraphrased on camera", "speakerNote": "a short delivery cue for this slide", "timing": "minutes for this slide, e.g. '2 min'", "sectionName": "the framework phase name this slide belongs to" }
  ]
}

Rules:
- Produce 10 to 12 slides, numbered 1..N in order. This is a fixed 15-20 minute recorded video — do NOT scale the count to any run time.
- The arc MUST follow the framework's ACTUAL phases in order: open with a hook slide, move through the teaching phases applied to this blueprint's problem, surface the key insight, and close with a soft next-step slide.
- sectionName MUST be a real framework phase name (or "Hook" for the opening slide and "Next step" for the closing slide).
- The per-slide timing values must sum to roughly 15-20 minutes.
- script is the spoken content grounded in this blueprint and the audience's language — specific teaching, not vague restatements of the title. No live-audience or "welcome to today's session" language; this is recorded solo.
- If a COACH'S OWN OPENING STORY is provided in the AUTHORSHIP block, the opening hook slide's script MUST weave it in as the coach's own opening — in their voice, teaching-first, preserving their words (frame around them, do not paraphrase them away). If none is provided, write a strong hook and do NOT fabricate a personal story.
- If a COACH'S SIGNATURE EXAMPLE is provided, work it into a teaching slide where it fits naturally, preserving their words.
- The final slide is a soft next-step slide, teaching-first, no hard pitch, grounded in the blueprint's suggested_offer. Reflect the CTA in the grounding: for book_call, invite the viewer to book a call and use the token [BOOK_A_CALL_LINK]; for sell_program, invite them to get the program directly and use the token [OFFER_LINK]. Use only the applicable link.
${SHARED_RULES}`,
  },
  workbook: {
    key: 'workbook',
    maxTokens: 5000,
    prompt: `You build the companion worksheet a viewer downloads AFTER watching the recorded micro-training, to apply the teaching on their own. It follows the same arc as the video and gives the viewer prompts and reflection space.

{
  "workbook": {
    "title": "worksheet title",
    "intro": "a short intro paragraph orienting the viewer to applying what they just watched",
    "sections": [
      { "sectionTitle": "section title (mapped to a framework phase)", "keyInsight": "the one key insight of this section", "exercises": [ { "prompt": "an apply-it prompt the viewer works through on their own", "lines": 4 } ], "reflection": "a reflection question to close the section" }
    ],
    "keyTakeaways": ["a concrete takeaway", "another"]
  }
}

Rules:
- This is a solo takeaway worksheet, not live workshop exercises — frame everything as the viewer applying the teaching after watching.
- sections mirror the framework phases in order, same arc as the video.
- Each section has 1-3 exercises; "lines" is how many blank lines to leave for the answer (an integer 2-8).
- keyInsight, prompts, and reflection are specific to this blueprint's problem and this audience — no generic worksheet filler.
- keyTakeaways: 3-5 concrete takeaways the viewer leaves with.
${SHARED_RULES}`,
  },
  recording_tips: {
    key: 'recording_tips',
    maxTokens: 2200,
    prompt: `You write recording tips for the coach filming this micro-training solo on camera — pacing, energy on camera, and simple setup — tuned to THIS specific video.

{
  "recording_tips": [ { "category": "a short category label, e.g. 'Pacing', 'Energy', or 'Setup'", "tip": "a specific, usable recording tip for THIS video" } ]
}

Rules:
- 5-8 tips, each grounded in this specific video's arc and this coach's material.
- Tips are for recording a solo teaching video (delivery, energy on camera, framing, keeping momentum through the arc), not for facilitating a live session or public speaking generalities.
${SHARED_RULES}`,
  },
  emails: {
    key: 'emails',
    maxTokens: 4000,
    prompt: `You write the registration email sequence (3 emails) that gets a registrant to actually watch the recorded micro-training video.

{
  "emails": [
    { "email_number": 1, "send_timing": "immediately after registration", "subject": "subject line", "body": "full email body — warm, direct, in the coach's voice. Confirm registration, remind them what they will learn and why it matters, end with the video link as [TRAINING_LINK]." },
    { "email_number": 2, "send_timing": "1 day after registration if not yet watched", "subject": "subject line", "body": "reference the specific problem this training solves, build mild real urgency, end with [TRAINING_LINK]." },
    { "email_number": 3, "send_timing": "final reminder", "subject": "subject line", "body": "final nudge, one clear reason to watch now, end with [TRAINING_LINK]." }
  ]
}

Rules:
- Exactly 3 emails, grounded in this blueprint's problem and this audience's language, signed by the coach (use the presenter name).
- These emails are about WATCHING the recorded video — no live-session language (no "attend", "seat", "join us live"). Do not pitch the offer or a call here.
${SHARED_RULES}`,
  },
  book_a_call: {
    key: 'book_a_call',
    maxTokens: 4000,
    prompt: `You write the post-video CLOSING email sequence (3 emails) for a viewer who watched the recorded training. The sequence is driven by the CTA in the grounding — read the CTA block and produce the matching variant.

Output key is always "book_a_call_emails" (this is the training's closing sequence, whatever the CTA):

{
  "book_a_call_emails": [
    { "email_number": 1, "send_timing": "same day, after watching", "subject": "subject line", "body": "..." },
    { "email_number": 2, "send_timing": "2 days after", "subject": "subject line", "body": "..." },
    { "email_number": 3, "send_timing": "4 days after", "subject": "subject line", "body": "..." }
  ]
}

Branch on the CTA TYPE in the grounding:
- cta_type = book_call: 3 emails that softly invite the viewer to BOOK A CALL. Email 1 warm and personal, referencing what they just learned and the shift it created; email 2 names the single most common objection to booking and reframes it with empathy; email 3 a final soft nudge. EVERY email ends with the token [BOOK_A_CALL_LINK].
- cta_type = sell_program: 3 emails that softly invite the viewer to GET THE PROGRAM DIRECTLY. Email 1 warm and personal, referencing what they just learned and the shift it created; email 2 names the single most common objection to buying and reframes it with empathy; email 3 a final soft nudge. EVERY email ends with the token [OFFER_LINK].

Rules for BOTH variants:
- Exactly 3 emails, grounded in this blueprint's problem/solution, naming the transformation and the blueprint's suggested_offer, signed by the coach (use the presenter name).
- Teaching-first: reference what they learned, no hard pitch, no false scarcity.
- Use ONLY the target link the CTA block designates — do not include the other link.
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

function coerceRecordingTips(v: unknown): MtRecordingTip[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => ({ category: asString(r.category), tip: asString(r.tip) }))
    .filter((t) => t.tip.trim().length > 0)
}

// One Anthropic call for a unit: logs cost and returns its text + whether the
// model stopped at max_tokens (a genuine truncation, distinct from control-char
// parse issues which extractJson repairs).
async function callUnitOnce(
  userId: string,
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<{ text: string; truncated: boolean }> {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: userMessage }],
  })
  await logApiCost(userId, 'generate', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)
  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  return { text: textBlock?.text ?? '', truncated: message.stop_reason === 'max_tokens' }
}

// Calls a unit and parses its JSON, with a SINGLE automatic retry (more
// max_tokens headroom) when the first attempt is truncated (stop_reason
// max_tokens) or won't parse. A still-bad retry throws GenerationParseError,
// which the endpoint maps to 502 generation_truncated.
async function callAndParse(userId: string, system: string, userMessage: string, maxTokens: number): Promise<any> {
  const first = await callUnitOnce(userId, system, userMessage, maxTokens)
  if (!first.truncated) {
    try {
      return extractJson(first.text)
    } catch (err) {
      if (!(err instanceof GenerationParseError)) throw err
      // fall through to the retry
    }
  }
  const retryTokens = Math.min(16000, Math.round(maxTokens * 1.6))
  const second = await callUnitOnce(userId, system, userMessage, retryTokens)
  return extractJson(second.text)
}

// ── Unit runner ─────────────────────────────────────────────────────────────
// Runs one unit's Anthropic call (with a single truncation retry) and returns
// the parsed partial. Throws GenerationParseError on a still-unparseable retry,
// which callers map to 502 generation_truncated. Each call logs its own cost.
async function runUnit(
  userId: string,
  unit: AssetUnit,
  grounding: string,
  voiceContext?: string
): Promise<Partial<MicroTraining>> {
  const spec = UNIT_SPECS[unit]
  const system = voiceContext ? `${spec.prompt}\n\n${voiceContext}` : spec.prompt
  const parsed = await callAndParse(userId, system, `${grounding}\n\nGenerate now.`, spec.maxTokens)

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
    case 'recording_tips':
      return { recording_tips: coerceRecordingTips(parsed.recording_tips) }
    case 'emails':
      return { emails: coerceEmails(parsed.emails) }
    case 'book_a_call':
      return { book_a_call_emails: coerceEmails(parsed.book_a_call_emails) }
  }
}

// Full generate — two waves so the downstream assets align to the FINAL title.
// Wave 1: meta first, fixing chosen_topic (+ subtitle). Wave 2: the remaining
// five units in parallel, grounded through withTitle(grounding, chosen_topic) —
// the same helper the regenerate path uses. Merged exactly as before. If any
// unit throws (including GenerationParseError), the whole generate fails so the
// caller returns an error rather than persisting a half-populated record.
export async function generateMicroTraining(userId: string, inputs: GeneratorInputs): Promise<MicroTraining> {
  const grounding = buildGrounding(inputs)

  const metaPart = await runUnit(userId, 'meta', grounding, inputs.voiceContext)
  const chosenTopic = typeof metaPart.chosen_topic === 'string' ? metaPart.chosen_topic : ''

  const rest: AssetUnit[] = ['slides', 'workbook', 'recording_tips', 'emails', 'book_a_call']
  const titledGrounding = withTitle(grounding, chosenTopic)
  const restParts = await Promise.all(rest.map((u) => runUnit(userId, u, titledGrounding, inputs.voiceContext)))

  const merged = Object.assign({}, metaPart, ...restParts) as Partial<MicroTraining>
  return {
    topics: merged.topics ?? [],
    chosen_topic: merged.chosen_topic ?? '',
    subtitle: merged.subtitle ?? '',
    // The Micro-Training is always a 15-20 minute recorded video.
    total_duration: merged.total_duration ?? '15-20 minutes',
    outline: merged.outline ?? [],
    slides: merged.slides ?? [],
    workbook: merged.workbook ?? { title: '', intro: '', sections: [], keyTakeaways: [] },
    emails: merged.emails ?? [],
    book_a_call_emails: merged.book_a_call_emails ?? [],
    recording_tips: merged.recording_tips ?? [],
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
  return runUnit(userId, unit, withTitle(buildGrounding(inputs), chosenTopic), inputs.voiceContext)
}

function withTitle(grounding: string, chosenTopic: string): string {
  return chosenTopic.trim().length > 0
    ? `${grounding}\nCURRENT TRAINING TITLE (align this asset to it): ${JSON.stringify(chosenTopic)}`
    : grounding
}

const SCRIPT_PROMPT = `You rewrite ONLY the spoken script for each slide of an existing micro-training deck. Keep every slide's title, timing, and section exactly as given — you are refreshing the words the coach speaks on camera in this recorded video, not restructuring the deck.

You are given the existing deck (each slide's number, title, section, and timing) plus the coach's grounding data. Return new spoken script for every slide, matched by slideNumber.

{
  "slides": [ { "slideNumber": 1, "script": "the new spoken script for this slide, grounded in this blueprint and the audience's language" } ]
}

Rules:
- Return one entry per slide given, same slideNumber values, in order.
- script is what the coach says on camera — specific teaching grounded in this blueprint's problem/solution and this audience, not vague restatements of the slide title.
- The final slide's script keeps its soft, teaching-first next-step framing referencing the blueprint's suggested_offer.
${SHARED_RULES}`

// Regenerate the spoken script of each existing slide in place, preserving every
// slide's slideTitle / speakerNote / timing / sectionName. Slides whose script
// the model doesn't return keep their current script.
export async function regenerateScript(
  userId: string,
  inputs: GeneratorInputs,
  currentSlides: MtSlide[],
  chosenTopic: string
): Promise<MtSlide[]> {
  const deck = currentSlides.map((s) => ({
    slideNumber: s.slideNumber,
    slideTitle: s.slideTitle,
    sectionName: s.sectionName,
    timing: s.timing,
  }))
  const grounding = `${withTitle(buildGrounding(inputs), chosenTopic)}
EXISTING DECK (rewrite the script for each, keep everything else): ${JSON.stringify(deck)}`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    thinking: { type: 'disabled' },
    system: inputs.voiceContext ? `${SCRIPT_PROMPT}\n\n${inputs.voiceContext}` : SCRIPT_PROMPT,
    messages: [{ role: 'user', content: `${grounding}\n\nRewrite the scripts now.` }],
  })
  await logApiCost(userId, 'generate', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const parsed = extractJson(textBlock?.text ?? '')
  const rawScripts = Array.isArray(parsed.slides) ? parsed.slides : []
  const byNumber = new Map<number, string>()
  for (const r of rawScripts) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    if (typeof o.slideNumber === 'number' && typeof o.script === 'string' && o.script.trim().length > 0) {
      byNumber.set(o.slideNumber, o.script)
    }
  }
  return currentSlides.map((s) => ({ ...s, script: byNumber.get(s.slideNumber) ?? s.script }))
}

export { GenerationParseError }
