import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson, GenerationParseError } from './aiJson'
import { logApiCost } from './apiCostLog'
import { SALES_FRAMEWORK_CANONICAL, SALES_SCRIPT_BEATS, OBJECTION_LOOPS, type ObjectionLoop } from './salesFrameworksCanonical'
import { COPYWRITING_CANONICAL } from './copywritingCanonical'
import { EMAIL_CANONICAL } from './emailCanonical'

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

// score: how well this angle/hook fits the audience (0-10, one decimal). The
// Angle step renders it as a fit meter like the blueprint cards' match_strength.
export type MtTopic = { title: string; angle: string; why: string; score: number }
export type MtOutlineItem = { section_number: number; title: string; description: string }
export type MtSlide = {
  slideNumber: number
  slideTitle: string
  script: string
  speakerNote: string
  timing: string
  sectionName: string
}
// recommended marks the default subset the frontend pre-selects from the pool of
// candidate exercises; the coach can add or remove the rest. collects/why_fits are
// per-question guidance (what the question surfaces, how it fits the phase).
export type MtExercise = { prompt: string; lines: number; recommended: boolean; collects: string; why_fits: string }
export type MtWorkbookSection = { sectionTitle: string; keyInsight: string; exercises: MtExercise[]; reflection: string }
// Both CTA variants are generated so the frontend can show whichever the coach's
// cta_type selects; book_call ends with [BOOK_A_CALL_LINK], sell_program with [OFFER_LINK].
export type MtClosingInvite = { book_call: string; sell_program: string }
// The lead-facing Guide (given at opt-in — stands alone, does NOT assume the lead
// watched the video). problem_intro/understanding/closing_invite are the new
// self-contained fields; title/intro/sections/keyTakeaways are kept for back-compat.
export type MtWorkbook = {
  title: string
  intro: string
  problem_intro: string
  understanding: string
  sections: MtWorkbookSection[]
  keyTakeaways: string[]
  closing_invite: MtClosingInvite
}
export type MtEmail = { email_number: number; send_timing: string; subject: string; body: string }
export type MtRecordingTip = { category: string; tip: string }

// ── Build-wizard net-new assets ─────────────────────────────────────────────
// The 6-beat call script and the objection set, both grounded on the house
// sales methodology (lib/salesFrameworksCanonical.ts). One beat = one moment of
// the call: the prospect's mindset, the phrasing options the coach could say,
// and the recommended default. One objection = a captured audience objection in
// the prospect's own voice, its handling, and which of the four loops it is.
export type MtScriptBeat = {
  beat: string
  prospect_mindset: string
  phrasing_options: string[]
  recommended: string
}
export type MtObjection = {
  objection: string
  handling: string
  loop: ObjectionLoop
}
// A lightweight per-angle preview so the Angle step can switch instantly without
// regenerating the whole training. Derived from the meta unit's topic options.
// title + angle are the INTERNAL positioning concept (the topic the coach picks
// between); the landing_* / curiosity_bullets / cta_label are the PUBLIC opt-in
// copy built FROM that angle, grounded on the copywriting canonical — never the
// raw angle title.
export type MtAnglePreview = {
  title: string
  angle: string
  landing_headline: string
  landing_subheadline: string
  curiosity_bullets: string[]
  cta_label: string
}

export type MicroTraining = {
  topics: MtTopic[]
  chosen_topic: string
  subtitle: string
  total_duration: string
  outline: MtOutlineItem[]
  slides: MtSlide[]
  workbook: MtWorkbook
  warm_invite_emails: MtEmail[]
  emails: MtEmail[]
  book_a_call_emails: MtEmail[]
  recording_tips: MtRecordingTip[]
  sales_script: MtScriptBeat[]
  objections: MtObjection[]
  angle_previews: MtAnglePreview[]
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
export type AssetUnit =
  | 'meta'
  | 'slides'
  | 'workbook'
  | 'recording_tips'
  | 'warm_invite'
  | 'emails'
  | 'book_a_call'
  | 'sales_script'
  | 'objections'
  | 'angle_previews'

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

  // For an asset that generates BOTH cta variants (e.g. the guide's closing
  // invite), both token→URL mappings must be present so each variant resolves.
  const bothCtaBlock = `BOTH CTA LINKS (only for an asset that generates BOTH a book_call and a sell_program variant):
- book_call variant → end with the token [BOOK_A_CALL_LINK] (resolves to ${callUrl}).
- sell_program variant → end with the token [OFFER_LINK] (resolves to ${sellUrl}).`

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
${bothCtaBlock}
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
  "topics": [ { "title": "title option", "angle": "the specific hook or framing", "why": "one sentence, spoken TO the coach, on why this hook lands — name the specific belief, fear, or phrase it echoes in their audience. Address the coach as 'you/your audience.' Never refer to the audience as a named persona or as 'she/he/they,' and never mention 'data,' scores, matching, or any internal system.", "score": 8.4 } ],
  "chosen_topic": "the ONE recommended primary title (may match one of the topics or be a sharper version of the strongest) — this is the working title",
  "subtitle": "a one-line subtitle that clarifies the promise",
  "total_duration": "the video run time in words — always in the 15-20 minute range (e.g. '15-20 minutes')",
  "outline": [ { "section_number": 1, "title": "section title", "description": "one sentence on what this section covers" } ]
}

Rules:
- topics: exactly 5 distinct options, each grounded in this blueprint's problem and this audience's language.
- score each topic 0-10 (one decimal) on how well its hook FITS this audience — higher when the hook mirrors the audience's OWN language and beliefs and pulls them into watching the training, lower when it's generic or off-angle. Make the scores genuinely DIFFERENTIATE across the 5 options (spread them out — do not cluster them all near the same value); the weakest option should score clearly below the strongest.
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
    maxTokens: 6500,
    prompt: `You build the lead-facing GUIDE — a self-contained downloadable a lead receives AT OPT-IN. It must stand ALONE: do NOT assume they have watched the video. It works before or after the training. Never use "after watching," "you just watched," or "as you saw in the video" framing. It walks the lead through the ONE problem, meets them where they are, gives them apply-it prompts, and ends with an honest invitation. Ground the copy in the copywriting canonical and, for the closing invite, the sales methodology below.

${COPYWRITING_CANONICAL}

${SALES_FRAMEWORK_CANONICAL}

{
  "workbook": {
    "title": "guide title",
    "intro": "a short intro paragraph orienting the lead to the guide, self-contained (does not reference a video)",
    "problem_intro": "page-1 opener written as a PERSONAL LETTER from the coach to the reader — warm, first person, addressed to 'you', framing the ONE problem through that personal lens. Short paragraphs separated by blank lines. Not a detached synopsis.",
    "understanding": "page-2 empathetic, second-person 'here's where you're at' section drawn from the audience intelligence, in the lead's OWN language ('You've probably felt X, caught yourself saying Y…'). Credibility-through-understanding for a coach without testimonials. Short paragraphs separated by blank lines.",
    "sections": [
      { "sectionTitle": "section title (mapped to a framework phase)", "keyInsight": "the one key insight of this section", "exercises": [ { "prompt": "an apply-it prompt the lead works through on their own", "lines": 4, "recommended": true, "collects": "one line: what information this question surfaces from the reader", "why_fits": "one line: how it fits this phase and what it sets up next" } ], "reflection": "a reflection question to close the section" }
    ],
    "keyTakeaways": ["a concrete takeaway", "another"],
    "closing_invite": {
      "book_call": "the coach speaking to the lead in FIRST person ('On it, I'll look at…', 'I built this for…') — an honest, bounded invitation to book a call, addressing the lead as 'you': what the next step is, who it's for, one honest disqualifier. Not a pitch. Short paragraphs separated by blank lines. Ends with [BOOK_A_CALL_LINK].",
      "sell_program": "the same first-person, honest, bounded invitation but to get the program directly. Short paragraphs separated by blank lines. Ends with [OFFER_LINK]."
    }
  }
}

Rules:
- Self-contained lead-facing guide given at opt-in. NEVER assume the lead watched the video; drop all "after watching / you just watched" framing. It works before or after the training.
- problem_intro: page 1, written as a PERSONAL LETTER from the coach to the reader — warm, first person, addressed to "you," framing the ONE blueprint problem through that personal lens. Not a detached synopsis.
- understanding: page 2, empathetic second-person "here's where you're at," drawn from the audience intelligence and written in the lead's own language. Do NOT expose a labeled profile or a "language patterns" list — weave it into natural prose. Follow the coach-facing rules: no persona/avatar names (no "Sarah"), no internal jargon.
- sections mirror the framework phases in order.
- exercises are a POOL of candidate apply-it prompts: generate a few candidates per section (3-4), and set "recommended": true on ONLY the ONE strongest question per section, false on all the rest, so the coach starts from a lean default and can add the others. "lines" is how many blank lines to leave for the answer (an integer 2-8).
- each exercise carries "collects" (one line: what information this question surfaces from the reader) and "why_fits" (one line: how it fits this phase and what it sets up next).
- keyInsight, prompts, and reflection are specific to this blueprint's problem and this audience — no generic worksheet filler.
- keyTakeaways: 3-5 concrete takeaways.
- closing_invite: generate BOTH variants. Each is an honest, bounded invitation grounded in the sales methodology (collect a yes, don't chase a no) — state what the next step is, who it's for, and one honest disqualifier. Not a pitch, no false scarcity, no hype.
- closing_invite is the COACH speaking directly to the lead: write both variants in FIRST person ("On it, I'll look at…", "I built this for…"), addressing the lead as "you". Never refer to the coach in third person or by name in the closing invite.
- Per the BOTH CTA LINKS block in the grounding, the book_call copy ends with [BOOK_A_CALL_LINK] and the sell_program copy ends with [OFFER_LINK]. Do not cross the tokens.
- Write problem_intro, understanding, and BOTH closing_invite variants as SHORT paragraphs separated by a blank line (\\n\\n) — never one solid block.
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
- Never name the audience by a persona or avatar name (no "Sarah"). Refer to them as "your audience," "your viewer," or "them."
- Address the coach as "you," never by their name.
${SHARED_RULES}`,
  },
  warm_invite: {
    key: 'warm_invite',
    maxTokens: 4500,
    prompt: `You write the WARM-MARKET INVITE sequence (3 broadcast emails) the coach sends to their EXISTING warm list BEFORE anyone opts in — to earn the click to the opt-in page so they register and watch the free training. Ground the copy in the copywriting canonical and the email canonical below (the Warm-market invite per-type job).

${COPYWRITING_CANONICAL}

${EMAIL_CANONICAL}

{
  "warm_invite_emails": [
    { "email_number": 1, "send_timing": "day 1 — announce the training", "subject": "subject line", "body": "lead with the reader's problem in 'you' language, tease the training's payoff, invite them to register. End with the opt-in CTA using [REGISTER_LINK]." },
    { "email_number": 2, "send_timing": "day 3 — the specific result", "subject": "subject line", "body": "go deeper on the transformation the training opens the door to and who it is for, in 'you' language. End with [REGISTER_LINK]." },
    { "email_number": 3, "send_timing": "day 5 — last call to register", "subject": "subject line", "body": "one clear, honest reason to register and watch now. End with [REGISTER_LINK]." }
  ]
}

Rules:
- Exactly 3 emails. Do NOT sign the body or append the coach's name — the signature is added by the render. End each body at its final line. These go to an EXISTING warm audience who have NOT opted in yet, so the job is to earn the registration — do not talk as if they already registered.
- Reference the training's promise/angle and the offer's transformation, grounded in this blueprint and this audience. Second person, honest, non-guru: no manufactured scarcity, no inflated or guaranteed promises, no hype vocabulary.
- One CTA per email, to the opt-in page, using the token [REGISTER_LINK]. Do not use the training/watch link or the call/offer link here — this is pre-opt-in.
- Format each body per the email canonical: short paragraphs of 2-3 sentences, each separated by a blank line. Never one block.
${SHARED_RULES}`,
  },
  emails: {
    key: 'emails',
    maxTokens: 4000,
    prompt: `You write the post-opt-in WATCH sequence (3 emails) that gets a registrant to actually watch the recorded micro-training video. Email 1 is the CONFIRMATION; emails 2-3 are WATCH NUDGES to someone who registered but has NOT watched yet. Ground the copy in the copywriting canonical and the email canonical below (email 1 is the Confirmation per-type job; emails 2-3 are the Watch nudge job).

${COPYWRITING_CANONICAL}

${EMAIL_CANONICAL}

{
  "emails": [
    { "email_number": 1, "send_timing": "immediately after registration", "subject": "subject line", "body": "the confirmation — warm thanks, they're in, what they'll get (specific), one watch CTA using [TRAINING_LINK], a short 'here's what to expect', and prime the next email. Add a P.S. with a backup [TRAINING_LINK]." },
    { "email_number": 2, "send_timing": "1 day after registration if not yet watched", "subject": "subject line", "body": "name that they registered and haven't watched yet, give ONE specific reason to watch now tied to the problem this training solves. One CTA, end with [TRAINING_LINK]." },
    { "email_number": 3, "send_timing": "final reminder if still not watched", "subject": "subject line", "body": "a final watch-nudge to someone who registered but still hasn't watched — one clear reason to watch now. One CTA, end with [TRAINING_LINK]." }
  ]
}

Rules:
- Exactly 3 emails, grounded in this blueprint's problem and this audience's language. Do NOT sign the body or append the coach's name — the signature is added by the render. End each body at its final line.
- Email 1 is the confirmation (deliver the watch link, set the expectation to watch now, prime the next email, P.S. backup link); emails 2-3 explicitly nudge someone who opted in but hasn't watched (name that they registered and haven't watched yet). Teaching-first, honest, non-guru.
- These emails are about WATCHING the recorded video — no live-session language (no "attend", "seat", "join us live"). Do not pitch the offer or a call here.
- Format each body per the email canonical: short paragraphs of 2-3 sentences, each separated by a blank line. Never one block.
${SHARED_RULES}`,
  },
  book_a_call: {
    key: 'book_a_call',
    maxTokens: 4500,
    prompt: `You write the post-video CONVERSION email sequence (3 emails) for a viewer who watched the recorded training — these close the loop and get them to take the next step. The sequence is driven by the CTA in the grounding — read the CTA block and produce the matching variant. These are the strongest emails in the suite: more direct than a watch-nudge, grounded in the copywriting canonical, the house sales methodology, and the email canonical below (the Book-a-call / conversion per-type job).

${COPYWRITING_CANONICAL}

${SALES_FRAMEWORK_CANONICAL}

${EMAIL_CANONICAL}

Output key is always "book_a_call_emails" (this is the training's conversion sequence, whatever the CTA):

{
  "book_a_call_emails": [
    { "email_number": 1, "send_timing": "same day, after watching", "subject": "subject line", "body": "..." },
    { "email_number": 2, "send_timing": "2 days after", "subject": "subject line", "body": "..." },
    { "email_number": 3, "send_timing": "4 days after", "subject": "subject line", "body": "..." }
  ]
}

Branch on the CTA TYPE in the grounding:
- cta_type = book_call: 3 emails that invite the viewer to BOOK THE IMPLEMENTATION CALL. Email 1 names the specific transformation they now see is possible and the confident next step; email 2 names the real cost of staying stuck and reframes the main objection to booking; email 3 a clear, direct final call to book. EVERY email ends with the token [BOOK_A_CALL_LINK].
- cta_type = sell_program: 3 emails that invite the viewer to GET THE PROGRAM DIRECTLY. Email 1 names the specific transformation and the confident next step; email 2 names the real cost of staying stuck and reframes the main objection to buying; email 3 a clear, direct final call to get the program. EVERY email ends with the token [OFFER_LINK].

Rules for BOTH variants:
- Exactly 3 emails, grounded in this blueprint's problem/solution, naming the specific transformation and the blueprint's suggested_offer. Do NOT sign the body or append the coach's name — the signature is added by the render. End each body at its final line.
- Bring umph: stronger and more direct than the watch-nudges. Name the specific transformation, the real cost of staying stuck, and a confident, clear next step to book. Still honest and non-guru: no manufactured scarcity, no hype, no false urgency, no inflated or guaranteed promises.
- One CTA per email. Use ONLY the target link the CTA block designates — do not include the other link.
- Format each body per the email canonical: short paragraphs of 2-3 sentences, each separated by a blank line. Never one block.
${SHARED_RULES}`,
  },
  sales_script: {
    key: 'sales_script',
    maxTokens: 5000,
    prompt: `You write the coach's SALES CALL SCRIPT for the 1:1 call this training drives toward — grounded on the house sales methodology below. The script is the 6 beats of the call, in order, in the coach's own offer and audience language.

${SALES_FRAMEWORK_CANONICAL}

Output shape — exactly ${SALES_SCRIPT_BEATS.length} beats, in this order: ${JSON.stringify(SALES_SCRIPT_BEATS)}:

{
  "sales_script": [
    {
      "beat": "${SALES_SCRIPT_BEATS[0]}",
      "prospect_mindset": "one line in the prospect's own internal voice at this moment of the call — refer to the coach as 'you'/'them' from the prospect's POV, never name the coach in third person",
      "phrasing_options": ["a line the coach says live to a real prospect (whose name is unknown), in their own offer/audience language — a neutral opener or a bracketed [name] placeholder, never a fabricated or persona prospect name", "a second option", "an optional third"],
      "recommended": "the strongest of the phrasing options (or a blend) — the default the coach starts from"
    }
  ]
}

Rules:
- Exactly ${SALES_SCRIPT_BEATS.length} beats, using these beat names in this order: ${SALES_SCRIPT_BEATS.join(' → ')}.
- Each beat: one prospect_mindset line, 2-3 phrasing_options, and a recommended default (which should be one of the options or a blend of them).
- Phrasings are what the coach says OUT LOUD on the call — warm, plain, specific to THIS offer, transformation, and audience. Never canned or manipulative.
- The prospect on this call is a REAL person whose name we do not know: never insert a fabricated or persona prospect name (no "Sarah") into phrasing_options or recommended. Use a neutral opener ("Hey, thanks for making time…") or a clearly bracketed [name] placeholder the coach fills in.
- prospect_mindset is the prospect's OWN internal state: never name the coach in third person (no "Jamaul"). Refer to the coach as "you" or "them" from the prospect's point of view.
- Ground the language in the coach's real framework, transformation, and this blueprint's offer — no generic sales-script filler.
${SHARED_RULES}`,
  },
  objections: {
    key: 'objections',
    maxTokens: 5000,
    prompt: `You write the coach's OBJECTION HANDLING set for the sales call — grounded on the house sales methodology below. Work from the REAL objections captured in this coach's AUDIENCE INTELLIGENCE. For each captured audience objection, phrase it in the prospect's own words, give the handling, and map it to exactly one of the four objection loops.

${SALES_FRAMEWORK_CANONICAL}

Output shape:

{
  "objections": [
    {
      "objection": "the objection in the PROSPECT'S OWN WORDS — how they would actually say it out loud",
      "handling": "the words the coach actually says to the prospect, first person, spoken to one prospect ('I hear you — is this a cash-flow question, or…?'). Name the real concern with empathy, reframe through this coach's transformation and offer, then hand the decision back. Never narrate in third person ('the coach…', use the presenter name) and never refer to the prospect as a named persona or as 'she/he/they.'",
      "loop": "one of: ${OBJECTION_LOOPS.join(' | ')}"
    }
  ]
}

Rules:
- Draw the objections from the REAL objections in the AUDIENCE INTELLIGENCE — do not invent generic ones. Cover each distinct captured objection.
- objection is in the prospect's own voice; handling is grounded in THIS coach's offer and transformation; loop is exactly one of ${OBJECTION_LOOPS.join(' | ')}.
- These are handled PROACTIVELY (beat 5, "Without a shadow of doubt") — treat each objection as a soft yes to validate, not a no to beat. Use the matching loop's specific tactics from the methodology. Warm, share-not-sell; never argue, pressure, or build a close-the-no mechanic.
${SHARED_RULES}`,
  },
  angle_previews: {
    key: 'angle_previews',
    maxTokens: 3500,
    prompt: `You write the LANDING opt-in preview for each candidate training angle, so the coach can switch angles instantly in the Build wizard without regenerating the whole training. You are given the ANGLE OPTIONS (each with a title, angle, and why). Ground the copy in the copywriting canonical below.

${COPYWRITING_CANONICAL}

For each ANGLE OPTION, keep its title and angle as the INTERNAL positioning concept, and build the PUBLIC opt-in copy FROM that angle — the landing headline, sub-headline, exactly 3 curiosity bullets, and the CTA label:

{
  "angle_previews": [
    {
      "title": "the training title for this angle (from the option — the internal concept, unchanged)",
      "angle": "the angle/hook for this option (from the option — the internal concept, unchanged)",
      "landing_headline": "the public opt-in headline built FROM this angle, spoken to the reader as 'you' — the transformation/outcome, never the raw angle title",
      "landing_subheadline": "speaks to the reader as 'you', clarifies the promise, teases the mechanism without teaching it",
      "curiosity_bullets": ["bullet 1", "bullet 2", "bullet 3"],
      "cta_label": "a first-person, action CTA that references the training"
    }
  ]
}

Rules:
- One preview per ANGLE OPTION given, in the same order, keeping each option's title and angle exactly as the internal concept.
- Speak to ONE person as "you" throughout the headline, subheadline, and bullets — never name or label the segment (no "coaches," "most coaches," any niche/group). Describe their exact situation back to them in "you" language. The internal title/angle may stay a third-person label; the public copy may not.
- landing_headline is built FROM the angle and MUST NOT equal the angle's title (or a trivial restatement of it) — promise the outcome, not the training, spoken to the reader as "you".
- landing_subheadline speaks to the reader as "you" and teases the mechanism without teaching it.
- curiosity_bullets: EXACTLY 3, declarative, second person, selling the watching experience — no rhetorical-question openers, no "most [X]" opener, no "not X, it's Y" split, no em-dash splitting a clause.
- cta_label: first person, an action, references the training (e.g. "Yes! Send me the free training").
- Honest, non-guru: no manufactured scarcity, no inflated or guaranteed promises, no hype vocabulary.
${SHARED_RULES}`,
  },
}

// ── Coercers ────────────────────────────────────────────────────────────────
export function coerceTopics(v: unknown): MtTopic[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => ({
      title: asString(r.title),
      angle: asString(r.angle),
      why: asString(r.why),
      score: coerceScore(r.score),
    }))
    .filter((t) => t.title.trim().length > 0)
    .slice(0, 5)
}

// Clamp an angle fit score to 0-10 with one decimal; default 5.0 when missing or
// unparseable (mirrors the neutral midpoint fallback used for match factors).
function coerceScore(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 5
  return Math.round(Math.min(10, Math.max(0, n)) * 10) / 10
}

export function coerceOutline(v: unknown): MtOutlineItem[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r, i) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      const n = typeof o.section_number === 'number' && Number.isFinite(o.section_number) ? o.section_number : i + 1
      return { section_number: n, title: asString(o.title), description: asString(o.description) }
    })
    .filter((o) => o.title.trim().length > 0)
}

export function coerceSlides(v: unknown): MtSlide[] {
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

export function coerceWorkbook(v: unknown): MtWorkbook {
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
          return {
            prompt: asString(e.prompt),
            lines: Math.min(12, Math.max(1, lines)),
            recommended: e.recommended === true,
            collects: asString(e.collects),
            why_fits: asString(e.why_fits),
          }
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
  const ci = (o.closing_invite && typeof o.closing_invite === 'object' ? o.closing_invite : {}) as Record<string, unknown>
  return {
    title: asString(o.title),
    intro: asString(o.intro),
    problem_intro: asString(o.problem_intro),
    understanding: asString(o.understanding),
    sections,
    keyTakeaways: asStringArray(o.keyTakeaways),
    closing_invite: { book_call: asString(ci.book_call), sell_program: asString(ci.sell_program) },
  }
}

export function coerceEmails(v: unknown): MtEmail[] {
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

export function coerceRecordingTips(v: unknown): MtRecordingTip[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => ({ category: asString(r.category), tip: asString(r.tip) }))
    .filter((t) => t.tip.trim().length > 0)
}

// Coerce the 6-beat call script. Keeps at most one beat per canonical beat name
// where possible, but is tolerant: any beat rows with content are kept in order.
export function coerceSalesScript(v: unknown): MtScriptBeat[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => {
      const options = asStringArray(r.phrasing_options).filter((o) => o.trim().length > 0).slice(0, 3)
      const recommended = asString(r.recommended).trim().length > 0 ? asString(r.recommended) : options[0] ?? ''
      return {
        beat: asString(r.beat),
        prospect_mindset: asString(r.prospect_mindset),
        phrasing_options: options,
        recommended,
      }
    })
    .filter((b) => b.beat.trim().length > 0 && (b.phrasing_options.length > 0 || b.recommended.trim().length > 0))
    .slice(0, SALES_SCRIPT_BEATS.length)
}

const OBJECTION_LOOP_SET = new Set<string>(OBJECTION_LOOPS)

// Coerce the objection set. loop is snapped to a valid loop; rows with an
// unrecognized loop fall back to 'commitment' so a stray label never drops a
// real objection.
export function coerceObjections(v: unknown): MtObjection[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => {
      const rawLoop = asString(r.loop).trim().toLowerCase()
      const loop = (OBJECTION_LOOP_SET.has(rawLoop) ? rawLoop : 'commitment') as ObjectionLoop
      return { objection: asString(r.objection), handling: asString(r.handling), loop }
    })
    .filter((o) => o.objection.trim().length > 0)
}

export function coerceAnglePreviews(v: unknown): MtAnglePreview[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map((r) => ({
      title: asString(r.title),
      angle: asString(r.angle),
      landing_headline: asString(r.landing_headline),
      landing_subheadline: asString(r.landing_subheadline),
      curiosity_bullets: coerceCuriosityBullets(r.curiosity_bullets),
      cta_label: asString(r.cta_label).trim().length > 0 ? asString(r.cta_label) : 'Watch the free training',
    }))
    .filter((p) => p.title.trim().length > 0 || p.landing_headline.trim().length > 0)
    .slice(0, 5)
}

// Exactly 3 non-empty curiosity bullets: keep the non-empty ones (max 3), pad to
// 3 with empty strings so the shape is stable for the UI's three bullet slots.
function coerceCuriosityBullets(v: unknown): string[] {
  const bullets = asStringArray(v)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 3)
  while (bullets.length < 3) bullets.push('')
  return bullets
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
    case 'warm_invite':
      return { warm_invite_emails: coerceEmails(parsed.warm_invite_emails) }
    case 'emails':
      return { emails: coerceEmails(parsed.emails) }
    case 'book_a_call':
      return { book_a_call_emails: coerceEmails(parsed.book_a_call_emails) }
    case 'sales_script':
      return { sales_script: coerceSalesScript(parsed.sales_script) }
    case 'objections':
      return { objections: coerceObjections(parsed.objections) }
    case 'angle_previews':
      return { angle_previews: coerceAnglePreviews(parsed.angle_previews) }
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
  const topics = Array.isArray(metaPart.topics) ? metaPart.topics : []

  // Wave 2: the remaining full-length units, plus the two net-new sales assets,
  // all aligned to the final title. angle_previews is grounded on the meta unit's
  // topic options (withTopics), so it runs in the same wave with that grounding.
  const rest: AssetUnit[] = ['slides', 'workbook', 'recording_tips', 'warm_invite', 'emails', 'book_a_call', 'sales_script', 'objections']
  const titledGrounding = withTitle(grounding, chosenTopic)
  const restParts = await Promise.all([
    ...rest.map((u) => runUnit(userId, u, titledGrounding, inputs.voiceContext)),
    runUnit(userId, 'angle_previews', withTopics(titledGrounding, topics), inputs.voiceContext),
  ])

  const merged = Object.assign({}, metaPart, ...restParts) as Partial<MicroTraining>
  return {
    topics: merged.topics ?? [],
    chosen_topic: merged.chosen_topic ?? '',
    subtitle: merged.subtitle ?? '',
    // The Micro-Training is always a 15-20 minute recorded video.
    total_duration: merged.total_duration ?? '15-20 minutes',
    outline: merged.outline ?? [],
    slides: merged.slides ?? [],
    workbook: merged.workbook ?? { title: '', intro: '', problem_intro: '', understanding: '', sections: [], keyTakeaways: [], closing_invite: { book_call: '', sell_program: '' } },
    warm_invite_emails: merged.warm_invite_emails ?? [],
    emails: merged.emails ?? [],
    book_a_call_emails: merged.book_a_call_emails ?? [],
    recording_tips: merged.recording_tips ?? [],
    sales_script: merged.sales_script ?? [],
    objections: merged.objections ?? [],
    angle_previews: merged.angle_previews ?? [],
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

// Appends the candidate angle options to the grounding for the angle_previews
// unit. The previews are one-per-option, so the unit needs the exact options.
function withTopics(grounding: string, topics: MtTopic[]): string {
  return `${grounding}
ANGLE OPTIONS (produce one light preview per option, in this order, keeping each option's title and angle): ${JSON.stringify(topics)}`
}

// Regenerate just the lightweight angle previews from the current topic options.
// Used by the Angle step so switching angles is instant without regenerating the
// whole training. Returns only the angle_previews partial.
export async function generateAnglePreviews(
  userId: string,
  inputs: GeneratorInputs,
  chosenTopic: string,
  topics: MtTopic[]
): Promise<MtAnglePreview[]> {
  const grounding = withTopics(withTitle(buildGrounding(inputs), chosenTopic), topics)
  const part = await runUnit(userId, 'angle_previews', grounding, inputs.voiceContext)
  return part.angle_previews ?? []
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
