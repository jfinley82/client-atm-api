import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson, GenerationParseError } from './aiJson'
import { logApiCost } from './apiCostLog'
import { sanitizePhrasingDeep } from './phrasing'
import { SALES_FRAMEWORK_CANONICAL, SALES_SCRIPT_BEATS, OBJECTION_LOOPS, type ObjectionLoop } from './salesFrameworksCanonical'
import { COPYWRITING_CANONICAL } from './copywritingCanonical'
import { EMAIL_CANONICAL } from './emailCanonical'
import { SLIDES_CANONICAL } from './slideDeckCanonical'

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
// The one presentation move for a slide. kind drives the UI: only 'image' shows
// an image placeholder; 'screen_share' and 'just_talk' do not. note is a plain
// one-line example grounded in the coach's own framework/offer.
export type MtDeliveryMove = { kind: 'image' | 'screen_share' | 'just_talk'; note: string }

// The snapshot shape shared by `original` (editor-owned, for reset) and
// `gen_snapshot` (generator-owned, for customized_slides). script/speakerNote are
// legacy; talkingPoints/deliveryMove are the current content.
type SlideSnapshot = {
  slideTitle: string
  sectionName: string
  talkingPoints: string[]
  deliveryMove: MtDeliveryMove
  // legacy on-screen narration, kept so old decks still reset/compare
  script?: string
  speakerNote?: string
}

export type MtSlide = {
  slideNumber: number
  slideTitle: string
  // 3-5 short beats the coach conveys in their OWN voice, ordered — what to say,
  // not verbatim prose. The current on-screen/teaching content.
  talkingPoints: string[]
  // How the coach presents this slide (one move). See MtDeliveryMove.
  deliveryMove: MtDeliveryMove
  timing: string
  sectionName: string
  // Legacy on-screen narration — no longer generated or surfaced; the UI prefers
  // talkingPoints. Kept so old decks still show something and coerce cleanly.
  script?: string
  speakerNote?: string
  // Optional editable per-slide visual layout, persisted by the slide editor. The
  // generator never produces this; it only rides along when the editor saves it.
  elements?: unknown[]
  // Optional snapshot of our generated content, saved by the editor so a slide can
  // be reset to the generated version. Preserved as-sent; never stamped here.
  original?: SlideSnapshot
  // Generator-owned snapshot of the as-generated content, stamped at generation
  // time (full generate + slides/script regenerate) so a coach edit is detectable
  // on read for customized_slides. Distinct from `original`, which the editor owns
  // for reset — this field never participates in the editor's reset behavior. A
  // hand-added slide has none, so it reads as customization (lost on a rebuild).
  gen_snapshot?: SlideSnapshot
  // The slide editor's background swatch. Editor-owned and never generated; the
  // backend stores and returns it without interpreting it, so the shape stays
  // whatever the editor writes (`unknown`, like `elements`).
  bgColor?: unknown
}
// recommended marks the default subset the frontend pre-selects from the pool of
// candidate exercises; the coach can add or remove the rest. collects/why_fits are
// per-question guidance (what the question surfaces, how it fits the phase).
//
// `selected` is the COACH's choice and is deliberately a separate field rather
// than an overwrite of `recommended`. recommended is the generator's own output;
// once it is overwritten there is no way to tell an AI default from a coach edit,
// which is the same problem gen_snapshot solves for script beats and slides.
// Absent on every exercise in a section => the coach has not touched that section
// and `recommended` is the effective selection (see selectedExercises).
export type MtExercise = {
  prompt: string
  lines: number
  recommended: boolean
  collects: string
  why_fits: string
  selected?: boolean
}

// A section shows a POOL of candidates; the generator pre-picks one and the coach
// may add a second. Confirmed 2026-08-04. Enforced server-side on save so a client
// that forgets the cap cannot write a third.
export const MAX_SELECTED_EXERCISES_PER_SECTION = 2

/**
 * The exercises that actually belong in the guide for one section, in order.
 *
 * Falls back to `recommended` when the coach has never made a choice in this
 * section, so every generation that predates the selected flag renders exactly
 * as it does today. Capped regardless of what is stored — a row hand-edited to
 * three selections still renders two rather than silently widening the guide.
 */
export function selectedExercises<T extends { recommended?: boolean; selected?: boolean }>(exercises: T[]): T[] {
  const list = Array.isArray(exercises) ? exercises : []
  const coachChose = list.some((e) => typeof e?.selected === 'boolean')
  const chosen = coachChose ? list.filter((e) => e?.selected === true) : list.filter((e) => e?.recommended !== false)
  return chosen.slice(0, MAX_SELECTED_EXERCISES_PER_SECTION)
}
export type MtWorkbookSection = { sectionTitle: string; keyInsight: string; exercises: MtExercise[]; reflection: string }
// Both CTA variants are generated so the frontend can show whichever the coach's
// cta_type selects; book_call ends with [BOOK_A_CALL_LINK], sell_program with [OFFER_LINK].
export type MtClosingInvite = { book_call: string; sell_program: string }
// The recap beat on the lead-facing Guide (after the exercises, before the CTA):
// a PERSONAL LETTER from the coach. It leads with where the reader started when
// they opened the guide, names what they just did, reminds them this is only the
// first part, and gets personal about how it was vs. what it could be if they
// stick with it — building authority and teeing up the close.
export type MtRecap = { started: string; did: string; first_part: string; stick: string }
// The lead-facing from->to close, in clean SECOND PERSON with no avatar name — a
// bespoke rewrite of the third-person avatar before/after states. `bridge` is a
// lead-facing sentence (NOT the coach's third-person zoneOfImpact positioning).
// Generated lazily at guide render (lib/guideCopy) and persisted; new + existing
// generations backfill the same way.
export type MtTransformationClose = { before: string; after: string; bridge: string }
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
  recap: MtRecap
  transformationClose: MtTransformationClose
  closing_invite: MtClosingInvite
}
// original is the as-generated snapshot the editor stamps on load, so a coach
// edit to subject/body can be detected on read (mirrors MtSlide.original).
export type MtEmail = { email_number: number; send_timing: string; subject: string; body: string; original?: { subject: string; body: string } }
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
  // Generator-owned snapshot of the as-generated beat, stamped at generation time
  // (full generate + sales_script regenerate) so a coach edit to the phrasing
  // options / recommended line is detectable on read. Mirrors slides' gen_snapshot.
  gen_snapshot?: { beat: string; prospect_mindset: string; phrasing_options: string[]; recommended: string }
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
  chosen_angle: string
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
// proof is the coach's real result or testimonial in their own words (who,
// starting point, result, timeframe, source — whatever they actually have). It is
// the ONLY basis for the slides Proof beat; absent it, the Proof beat is omitted.
export type PersonalHook = { opening_story?: string; signature_example?: string; proof?: string }
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
  const proof = d.personal_hook?.proof?.trim()
  const ctaType: CtaType = d.cta_type === 'sell_program' ? 'sell_program' : 'book_call'
  const storyLine = story
    ? `- COACH'S OWN OPENING STORY (their words — weave into the hook, preserve them, do not paraphrase them away): ${JSON.stringify(story)}`
    : `- COACH'S OWN OPENING STORY: (none provided — write a strong hook, do NOT fabricate a personal story)`
  const exampleLine = example
    ? `- COACH'S SIGNATURE EXAMPLE (their words — work into the teaching where it fits naturally, preserve them): ${JSON.stringify(example)}`
    : `- COACH'S SIGNATURE EXAMPLE: (none provided)`
  const proofLine = proof
    ? `- COACH-PROVIDED PROOF (the ONLY basis for the Proof beat; use it verbatim in substance and invent nothing beyond it): ${JSON.stringify(proof)}`
    : `- PROOF: (none provided — OMIT the Proof beat entirely; do not fabricate a result, do not substitute an anonymous client case, and do not create a mechanism-only proof slide)`

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
${proofLine}
${ctaBlock}
${bothCtaBlock}
RECORDING DETAILS:
- presenter name (use when signing / referring to the coach): ${JSON.stringify(presenter)}
- coach's soft CTA line: ${ctaLine}`
}

// Shared header + guardrails appended to every unit's system prompt.
const SHARED_RULES = `Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

Ground EVERYTHING in the specific data provided — the coach's real audience language, their transformation, their named framework phases, and this one blueprint's problem/solution/offer. No generic coaching-industry filler that could apply to any topic. This is ONE pre-recorded 15-20 minute teaching video, not a live session: no welcome-the-room, no housekeeping, no Q&A, no live-audience or workshop language. Any call to action is soft and teaching-first: it references the blueprint's suggested_offer and invites the viewer to book a call, never a hard pitch.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

// A sharp, LOCAL reminder injected at the exact points hooks / titles / angles /
// subject lines are written. The distant style block loses to the punchy-hook
// ask, so name the shapes that keep slipping through and show a recast for each —
// the model needs the pattern, not just the prohibition. All recast examples are
// themselves style-compliant (direct claim or concrete image).
const HOOK_STYLE_REMINDER = `HOOK CONSTRUCTION. Write every hook, title, angle, and subject line as ONE of two things: a CONCRETE SITUATION (a specific, observable thing the reader actually does or lives) or a DIRECT CLAIM (a plain statement of the real dynamic). State the true thing straight. Do NOT set up a wrong frame and flip it — the negation-then-reframe move ("it's not X, it's Y", "you don't have an X problem, you have a Y problem", "you don't need another X", "X isn't broken", "that's not an X problem") is generic ad copy that reads as AI. If a line lands on any negation / contrast / reframe frame, rewrite it as the concrete situation or direct claim underneath it.
- "It's not a marketing problem, it's the friend zone" → "Your warmest followers ask you for advice, then pay someone else."
- "You don't need another script or more traffic" → "The people who already trust you are the ones you never ask."
- "Your funnel isn't broken" → "Your funnel does its job; your audience just learned your advice is free."`

// ── Per-unit prompts ────────────────────────────────────────────────────────
// Each unit's system prompt carries only its own schema + rules. max_tokens is
// sized per unit. On the full generate all six run in parallel; regenerate runs
// exactly one.
type UnitSpec = { key: AssetUnit; maxTokens: number; prompt: string }

export const UNIT_SPECS: Record<AssetUnit, UnitSpec> = {
  meta: {
    key: 'meta',
    maxTokens: 2500,
    prompt: `You design the framing for a coach's pre-recorded micro-training video. Produce the title options, the recommended primary title, the hook that title opens from, a subtitle, the run time, and a section outline.

{
  "topics": [ { "title": "title option", "angle": "the HOOK LINE itself — the one-line opening framing this title opens from, in the audience's language (the actual line, not a description of it and not a rationale)", "why": "one sentence, spoken TO the coach, on why this hook lands — name the specific belief, fear, or phrase it echoes in their audience. Address the coach as 'you/your audience.' Never refer to the audience as a named persona or as 'she/he/they,' and never mention 'data,' scores, matching, or any internal system.", "score": 8.4 } ],
  "chosen_topic": "the ONE recommended primary title (may match one of the topics or be a sharper version of the strongest) — this is the working title",
  "chosen_angle": "the one-line HOOK / opening framing that chosen_topic opens from, in the audience's language — the actual positioning line (NOT the coach-facing rationale, NOT a description of the angle). If chosen_topic matches a topic, this is that topic's angle; if chosen_topic is a sharpened title, write the matching hook for it.",
  "subtitle": "a one-line subtitle that clarifies the promise",
  "total_duration": "the video run time in words — always in the 15-20 minute range (e.g. '15-20 minutes')",
  "outline": [ { "section_number": 1, "title": "section title", "description": "one sentence on what this section covers" } ]
}

Rules:
- topics: exactly 5 distinct options, each grounded in this blueprint's problem and this audience's language. Each option's "angle" is the hook LINE itself (a line you could open the training with), not a rationale for it.
- score each topic 0-10 (one decimal) on how well its hook FITS this audience — higher when the hook mirrors the audience's OWN language and beliefs and pulls them into watching the training, lower when it's generic or off-angle. Make the scores genuinely DIFFERENTIATE across the 5 options (spread them out — do not cluster them all near the same value); the weakest option should score clearly below the strongest.
- chosen_topic must never be empty — pick the strongest, sharpened for this audience.
- chosen_angle must never be empty — it is the hook chosen_topic opens from, in the audience's language, and every other asset opens from it.
- The titles, every topic "angle", and chosen_angle are hooks, so check them against this before returning:
${HOOK_STYLE_REMINDER}
- total_duration is always a 15-20 minute recorded video — do not invent a longer run time.
- outline: the sections a viewer moves through in the recording, mapped to the framework's phases in order (hook, the teaching phases applied to this problem, the key insight, a soft next step). One entry per section.
${SHARED_RULES}`,
  },
  slides: {
    key: 'slides',
    maxTokens: 8000,
    prompt: `You build the slide deck the coach records the micro-training video from. Each slide gives the coach an on-screen assertion (slideTitle), 3-5 talking points (beats to CONVEY in their own voice, not a script to read), one delivery move (how to present the slide), its timing, and the beat it belongs to. Build the deck to the slide-deck doctrine below.

${SLIDES_CANONICAL}

{
  "slides": [
    { "slideNumber": 1, "slideTitle": "the assertion: a full-sentence conclusion under ~15 words", "talkingPoints": ["3-5 short beats the coach conveys in their OWN voice, ordered, in the audience's language — what to say, not verbatim prose"], "deliveryMove": { "kind": "image | screen_share | just_talk", "note": "one short line: the move for this slide" }, "timing": "minutes for this slide, e.g. '2 min'", "sectionName": "the beat name this slide belongs to" }
  ]
}

Rules:
- NO fixed slide count — size the deck to the ONE problem, never pad to a target and never compress a problem that needs teaching. Keep the whole thing inside the 15-20 minute window (usually 8-14 slides). Number slides 1..N in order.
- Generate the beats in the doctrine's ORDER (Cover, Qualify, Hidden bottleneck, Why the old way fails, Teaching, Framework reveal, Proof, Implementation gap, The call). A beat may take multiple slides (the teaching section flexes to the problem) and may merge with a neighbor or split in two if the problem calls for it, as long as the order holds and no beat is dropped.
- sectionName is the BEAT NAME the slide belongs to, exactly as named in the doctrine.
- The Proof beat is CONDITIONAL: include it ONLY if COACH-PROVIDED PROOF appears in the grounding, and ground it solely in that text — use only what the coach wrote, attribute it exactly as they wrote it, and invent no numbers or outcomes beyond their words. If no coach-provided proof is present, OMIT the Proof beat entirely (Framework reveal is followed directly by Implementation gap); never fabricate a result or a client case.
- The per-slide timing values must sum to roughly 15-20 minutes.
- talkingPoints are 3-5 short beats the coach hits IN THEIR OWN VOICE, in order, in the audience's language. Each is what to CONVEY, a beat to hit ("Open with the moment someone you helped for free hired someone else"), NOT a sentence to read verbatim and NOT a paragraph. Ground each in this blueprint and the audience's language, not vague restatements of the title. Where it helps, make one point a delivery cue ("Pause here, let it land"). Recorded solo: no live-audience or "welcome to today's session" language.
- deliveryMove is the ONE move for the slide. Choose kind HONESTLY per slide, and use all three where they fit — do NOT default everything to "just_talk" or "image": "image" when a static visual clearly strengthens the point; "screen_share" when showing something LIVE would land better than talking or a static picture (e.g. The call sharing the coach's booking page, a Teaching slide walking through a tool, document, worksheet, or screenshot, the Framework reveal as a live walk-through of the method); "just_talk" when the coach saying it straight to camera is strongest. Reach for "screen_share" wherever a live demo genuinely fits, but never force any kind where it does not. note is one short, plain line grounded in the coach's own framework or offer (e.g. "a simple 3-step flow of your process" for image, "your booking page" or "walk through your intake worksheet" for screen_share, "say this straight to camera, then pause" for just_talk).
- If a COACH'S OWN OPENING STORY is provided in the AUTHORSHIP block, the opening (the Cover/Qualify area) MUST weave it into the talking points as the coach's own opening — in their voice, teaching-first, preserving their words (frame around them, do not paraphrase them away). If none is provided, write a strong opening and do NOT fabricate a personal story.
- If a COACH'S SIGNATURE EXAMPLE is provided, work it into a teaching slide's talking points where it fits naturally, preserving their words.
- On "The call" beat, reflect the CTA in the grounding: for book_call, invite the viewer to book a call and use the token [BOOK_A_CALL_LINK]; for sell_program, invite them to get the program directly and use the token [OFFER_LINK]. Use only the applicable link. The CTA token ([BOOK_A_CALL_LINK] / [OFFER_LINK]) must appear INSIDE one of The call slide's talkingPoints — never as its own slide and never as a slide title.
- The Cover slide's title and its first talking point are the deck's hook, so check them against this before returning:
${HOOK_STYLE_REMINDER}
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
    "recap": {
      "started": "a short paragraph, second person, warm — remind the reader where they were when they OPENED this guide: the specific frustration they walked in with. Coach voice, like a personal letter.",
      "did": "a short paragraph: what they just did in these exercises — the honest self-audit — affirming and specific to THIS problem, not generic praise.",
      "first_part": "a short paragraph: gently remind them this guide is only the FIRST part — it names the pattern and starts the shift, it does not finish it.",
      "stick": "a short paragraph, personal and encouraging: contrast how it has felt with what it could be like if they stick with it — your genuine belief they can get there. Hands off into the invitation."
    },
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
- recap: a PERSONAL LETTER from the coach that comes AFTER the exercises and BEFORE the invitation. Second person, coach voice, warm, no hype. Four short-paragraph beats, in order: "started" leads with where the reader was when they OPENED the guide (the frustration they walked in with); "did" names what they just did; "first_part" reminds them this is only the first part; "stick" gets personal — how it has felt vs. what it could be like if they stick with it, in your genuine voice. It must SET UP the close, not repeat problem_intro. It is signed by the coach at render, so do NOT sign it or name the coach inside the text.
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
    { "email_number": 1, "send_timing": "day 1, announce the training", "subject": "subject line", "body": "..." },
    { "email_number": 2, "send_timing": "day 3, the specific result", "subject": "subject line", "body": "..." },
    { "email_number": 3, "send_timing": "day 5, last call to register", "subject": "subject line", "body": "..." }
  ]
}

Each email's job, in order:
- Email 1 announces the training: lead with the reader's problem in "you" language. Tease the payoff the training delivers. Invite them to register.
- Email 2 goes deeper on the specific result: the transformation the training opens the door to, and who it is for, in "you" language.
- Email 3 is the last call: one clear, honest reason to register and watch now.

Rules:
- Exactly 3 emails. Do NOT sign the body or append the coach's name — the signature is added by the render. End each body at its final line. These go to an EXISTING warm audience who have NOT opted in yet, so the job is to earn the registration — do not talk as if they already registered.
- Reference the training's promise/angle and the offer's transformation, grounded in this blueprint and this audience. Second person, honest, non-guru: no manufactured scarcity, no inflated or guaranteed promises, no hype vocabulary.
- One CTA per email, to the opt-in page, using the token [REGISTER_LINK]. Do not use the training/watch link or the call/offer link here — this is pre-opt-in.
- Format each body per the email canonical: AT LEAST 3 paragraphs of 2-3 sentences, each separated by a blank line, so every body contains at least two blank lines. The floor applies to SHORT bodies too — a brief email is still split into at least 3 paragraphs. One paragraph is never correct.
- Subject lines are hooks, so check each against this before returning:
${HOOK_STYLE_REMINDER}
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
    { "email_number": 1, "send_timing": "immediately after registration", "subject": "subject line", "body": "the confirmation — warm thanks, they're in, what they'll get (specific), one watch CTA using [TRAINING_LINK], a short 'here's what to expect', a brief companion line offering the Guide as a bonus resource (a few honest words on what it is) with the [GUIDE_LINK] token, and prime the next email. Add a P.S. with a backup [TRAINING_LINK]." },
    { "email_number": 2, "send_timing": "1 day after registration if not yet watched", "subject": "subject line", "body": "name that they registered and haven't watched yet, give ONE specific reason to watch now tied to the problem this training solves. One CTA, end with [TRAINING_LINK]." },
    { "email_number": 3, "send_timing": "final reminder if still not watched", "subject": "subject line", "body": "a final watch-nudge to someone who registered but still hasn't watched — one clear reason to watch now. One CTA, end with [TRAINING_LINK]." }
  ]
}

Rules:
- Exactly 3 emails, grounded in this blueprint's problem and this audience's language. Do NOT sign the body or append the coach's name — the signature is added by the render. End each body at its final line.
- Email 1 is the confirmation (deliver the watch link, set the expectation to watch now, prime the next email, P.S. backup link); emails 2-3 explicitly nudge someone who opted in but hasn't watched (name that they registered and haven't watched yet). Teaching-first, honest, non-guru.
- Email 1 (and ONLY email 1) may also offer the Guide as a bonus companion resource using the [GUIDE_LINK] token — one brief, honest line on what it is. It is a bonus, positioned BELOW the primary watch CTA and must NOT compete with it: [TRAINING_LINK] stays the main action. Do not use [GUIDE_LINK] in emails 2-3.
- These emails are about WATCHING the recorded video — no live-session language (no "attend", "seat", "join us live"). Do not pitch the offer or a call here.
- Format each body per the email canonical: AT LEAST 3 paragraphs of 2-3 sentences, each separated by a blank line, so every body contains at least two blank lines. The floor applies to SHORT bodies too — a brief email is still split into at least 3 paragraphs. One paragraph is never correct.
- Subject lines are hooks, so check each against this before returning:
${HOOK_STYLE_REMINDER}
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
- Format each body per the email canonical: AT LEAST 3 paragraphs of 2-3 sentences, each separated by a blank line, so every body contains at least two blank lines. The floor applies to SHORT bodies too — a brief email is still split into at least 3 paragraphs. One paragraph is never correct.
- Subject lines are hooks, so check each against this before returning:
${HOOK_STYLE_REMINDER}
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

/**
 * Fields the EDITOR writes that the GENERATOR never emits, per collection.
 *
 * Every coerce* below is an allowlist: it rebuilds each object from named keys
 * and drops the rest. That is deliberate and worth keeping — it is what stops
 * model output from writing arbitrary keys into a persisted blob. The cost is
 * that anything the editor owns must be named explicitly, or it is deleted by
 * the next save that round-trips the collection.
 *
 * That has now bitten three times: `elements`, `selected`, `bgColor`. Each was
 * found the same way — by accident, in production, after the data was already
 * gone. It cannot be found by inspecting stored rows, because a stripped field
 * is by definition absent from them.
 *
 * So this list is the checklist. When the editor starts persisting a new field:
 * add it here, add the passthrough in the matching coerce, and the round-trip
 * test in tests/coerceEditorFields.test.ts will hold it.
 */
export const EDITOR_OWNED_FIELDS = {
  slide: ['script', 'speakerNote', 'elements', 'original', 'gen_snapshot', 'bgColor'],
  exercise: ['selected'],
  email: ['original'],
  scriptBeat: ['gen_snapshot'],
} as const

export function coerceSlides(v: unknown): MtSlide[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r, i) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      const n = typeof o.slideNumber === 'number' && Number.isFinite(o.slideNumber) ? o.slideNumber : i + 1
      const dm = (o.deliveryMove && typeof o.deliveryMove === 'object' && !Array.isArray(o.deliveryMove) ? o.deliveryMove : {}) as Record<string, unknown>
      const dmKind = dm.kind === 'image' || dm.kind === 'screen_share' || dm.kind === 'just_talk' ? dm.kind : 'just_talk'
      const slide: MtSlide = {
        slideNumber: n,
        slideTitle: asString(o.slideTitle),
        talkingPoints: asStringArray(o.talkingPoints).filter((t) => t.trim().length > 0),
        deliveryMove: { kind: dmKind, note: asString(dm.note) },
        timing: asString(o.timing),
        sectionName: asString(o.sectionName),
      }
      // Legacy on-screen narration: pass it through when a stored/edited slide
      // still carries it, so old decks keep it. Not generated for new slides.
      if (typeof o.script === 'string' && o.script.length > 0) slide.script = o.script
      if (typeof o.speakerNote === 'string' && o.speakerNote.length > 0) slide.speakerNote = o.speakerNote
      // The slide editor's per-slide visual layout: pass it through untouched when
      // present as an array, leave it off otherwise.
      if (Array.isArray(o.elements)) slide.elements = o.elements
      // The editor's snapshot of the generated text (for reset): preserve as-sent
      // when present as an object, leave it off otherwise. Never stamped here.
      if (o.original && typeof o.original === 'object' && !Array.isArray(o.original)) {
        slide.original = o.original as MtSlide['original']
      }
      // The generator's as-generated snapshot (for customized_slides): pass it
      // through untouched so a save never drops the count baseline.
      if (o.gen_snapshot && typeof o.gen_snapshot === 'object' && !Array.isArray(o.gen_snapshot)) {
        slide.gen_snapshot = o.gen_snapshot as MtSlide['gen_snapshot']
      }
      // The editor's background swatch. Checked only for presence, not shape:
      // the backend never reads this value, and a narrower guess about its type
      // would be another way to drop it. See EDITOR_OWNED_FIELDS.
      if (o.bgColor !== undefined) slide.bgColor = o.bgColor
      return slide
    })
    .filter(
      (s) =>
        s.slideTitle.trim().length > 0 ||
        s.talkingPoints.length > 0 ||
        (typeof s.script === 'string' && s.script.trim().length > 0) ||
        (Array.isArray(s.elements) && s.elements.length > 0)
    )
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
          const exercise: MtExercise = {
            prompt: asString(e.prompt),
            lines: Math.min(12, Math.max(1, lines)),
            recommended: e.recommended === true,
            collects: asString(e.collects),
            why_fits: asString(e.why_fits),
          }
          // The coach's guide selection, written by PATCH /api/generate/exercises.
          // Carried through only when it is actually a boolean, so an untouched
          // section stays absent and selectedExercises() keeps falling back to
          // `recommended` rather than reading a section as "coach chose none".
          // See EDITOR_OWNED_FIELDS.
          if (typeof e.selected === 'boolean') exercise.selected = e.selected
          return exercise
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
  const rc = (o.recap && typeof o.recap === 'object' ? o.recap : {}) as Record<string, unknown>
  const tc = (o.transformationClose && typeof o.transformationClose === 'object' ? o.transformationClose : {}) as Record<string, unknown>
  return {
    title: asString(o.title),
    intro: asString(o.intro),
    problem_intro: asString(o.problem_intro),
    understanding: asString(o.understanding),
    sections,
    keyTakeaways: asStringArray(o.keyTakeaways),
    recap: { started: asString(rc.started), did: asString(rc.did), first_part: asString(rc.first_part), stick: asString(rc.stick) },
    transformationClose: { before: asString(tc.before), after: asString(tc.after), bridge: asString(tc.bridge) },
    closing_invite: { book_call: asString(ci.book_call), sell_program: asString(ci.sell_program) },
  }
}

export function coerceEmails(v: unknown): MtEmail[] {
  if (!Array.isArray(v)) return []
  return v
    .map((r, i) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      const n = typeof o.email_number === 'number' && Number.isFinite(o.email_number) ? o.email_number : i + 1
      const email: MtEmail = {
        email_number: n,
        send_timing: asString(o.send_timing),
        subject: asString(o.subject),
        body: asString(o.body),
      }
      // Preserve the editor's as-generated snapshot so a coach edit is detectable.
      if (o.original && typeof o.original === 'object') {
        const orig = o.original as Record<string, unknown>
        email.original = { subject: asString(orig.subject), body: asString(orig.body) }
      }
      return email
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
      const beat: MtScriptBeat = {
        beat: asString(r.beat),
        prospect_mindset: asString(r.prospect_mindset),
        phrasing_options: options,
        recommended,
      }
      // The generator's as-generated snapshot (for customized_script): pass it
      // through untouched so a save never drops the count baseline.
      if (r.gen_snapshot && typeof r.gen_snapshot === 'object' && !Array.isArray(r.gen_snapshot)) {
        beat.gen_snapshot = r.gen_snapshot as MtScriptBeat['gen_snapshot']
      }
      return beat
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

  const built = ((): Partial<MicroTraining> => {
    switch (unit) {
      case 'meta':
        return {
          topics: coerceTopics(parsed.topics),
          chosen_topic: asString(parsed.chosen_topic),
          chosen_angle: asString(parsed.chosen_angle),
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
  })()

  // Enforce the style guide's no-em-dash-clause-split rule on ALL generated copy —
  // the model ignores the injected instruction often enough (objections especially)
  // to need a deterministic pass. Phrasing-only; compounds/ranges are preserved.
  return sanitizePhrasingDeep(built)
}

// ── Hook-shape safety net ───────────────────────────────────────────────────
// The prompt reminder complies most of the time, but the negation/contrast/
// reframe class has infinite surface variants and is the model's default "good
// hook", so the high-visibility shipped fields get a deterministic scan + a
// single targeted repair call. Guarantees the fields that actually ship, whatever
// the model does on a given run.

// Structural signatures of the class, case-insensitive. Kept specific to limit
// false positives; the {0,40} windows stay inside one clause (no . ? !).
const HOOK_SHAPE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'isnt-x-its-y', re: /isn'?t\b[^.?!]{0,40},?\s*it'?s\b/i },
  { name: 'not-x-but-y', re: /\bnot\b[^.?!]{0,40},\s*but\b/i },
  { name: 'its-not-x-its-y', re: /\bit'?s not\b[^.?!]{0,40}\bit'?s\b/i },
  { name: 'not-about-x-its-about-y', re: /\bnot about\b[^.?!]{0,40}\bit'?s about\b/i },
  { name: 'dont-need-another', re: /\bdon'?t need another\b/i },
  { name: 'dont-have-a-x-problem', re: /\bdon'?t have (a|an)\b[^.?!]{0,40}\bproblem\b/i },
  { name: 'thats-a-x-problem', re: /\bthat'?s (a|an|not)\b[^.?!]{0,40}\bproblem\b/i },
  { name: 'isnt-broken', re: /\bisn'?t broken\b/i },
]

// The class shapes present in a string (empty = clean). Exported for testing.
export function matchHookShapes(s: string): string[] {
  if (typeof s !== 'string' || s.length === 0) return []
  return HOOK_SHAPE_PATTERNS.filter((p) => p.re.test(s)).map((p) => p.name)
}

// A field the scrubber can read and write back in place.
type HookSlot = { label: string; value: string; apply: (v: string) => void }

// Scan the slots; if any hit a class shape, make ONE targeted repair call that
// rewrites just the offenders as concrete situations / direct claims, then apply
// the repaired values. One pass only — a still-matching repair is kept, not
// re-looped. A failed repair keeps the originals. Logs when it fires + what hit.
async function repairHookSlots(
  userId: string,
  slots: HookSlot[],
  context: { chosen_topic: string; audience: unknown }
): Promise<void> {
  const offenders = slots.filter((s) => matchHookShapes(s.value).length > 0)
  if (offenders.length === 0) return

  const shapes = Array.from(new Set(offenders.flatMap((s) => matchHookShapes(s.value))))
  console.log('[microTraining] hook-shape repair firing', { fields: offenders.map((o) => o.label), shapes })

  const system = `You repair marketing hook lines that fell into a generic-ad-copy pattern. Rewrite each so it keeps the SAME meaning but is written straight, following this rule:

${HOOK_STYLE_REMINDER}

Return ONLY JSON, no preamble: { "fields": [ { "field": "<the field id, unchanged>", "text": "<the rewritten line, same meaning, no negation/contrast/reframe frame>" } ] }. Rewrite every field you are given and keep its field id exactly.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`
  const userMessage = `TRAINING TITLE: ${JSON.stringify(context.chosen_topic)}
AUDIENCE: ${JSON.stringify(context.audience)}
Rewrite these lines (keep each field's meaning, drop the banned frame):
${JSON.stringify(offenders.map((o) => ({ field: o.label, text: o.value })))}`

  let repaired: Record<string, string> = {}
  try {
    const parsed = await callAndParse(userId, system, userMessage, 1500)
    const arr = Array.isArray(parsed.fields) ? parsed.fields : []
    for (const r of arr) {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      if (typeof o.field === 'string' && typeof o.text === 'string' && o.text.trim().length > 0) {
        repaired[o.field] = o.text.trim()
      }
    }
  } catch (err) {
    console.error('[microTraining] hook-shape repair failed; keeping originals', err)
    return
  }

  const stillHit: string[] = []
  for (const o of offenders) {
    const val = repaired[o.label]
    if (!val) continue
    o.apply(val)
    if (matchHookShapes(val).length > 0) stillHit.push(o.label)
  }
  if (stillHit.length > 0) console.warn('[microTraining] hook-shape still present after one repair pass', { fields: stillHit })
}

// The shipped hook fields of a full MicroTraining, as writable slots.
function collectFullHookSlots(mt: MicroTraining): HookSlot[] {
  const slots: HookSlot[] = []
  slots.push({ label: 'chosen_topic', value: mt.chosen_topic, apply: (v) => { mt.chosen_topic = v } })
  slots.push({ label: 'chosen_angle', value: mt.chosen_angle, apply: (v) => { mt.chosen_angle = v } })
  if (mt.slides[0]) slots.push({ label: 'cover_title', value: mt.slides[0].slideTitle, apply: (v) => { mt.slides[0].slideTitle = v } })
  mt.topics.forEach((t, i) => {
    slots.push({ label: `topic_${i}_title`, value: t.title, apply: (v) => { mt.topics[i].title = v } })
    slots.push({ label: `topic_${i}_angle`, value: t.angle, apply: (v) => { mt.topics[i].angle = v } })
  })
  mt.emails.forEach((e, i) => slots.push({ label: `email_${i}_subject`, value: e.subject, apply: (v) => { mt.emails[i].subject = v } }))
  mt.warm_invite_emails.forEach((e, i) => slots.push({ label: `warm_${i}_subject`, value: e.subject, apply: (v) => { mt.warm_invite_emails[i].subject = v } }))
  mt.book_a_call_emails.forEach((e, i) => slots.push({ label: `booking_${i}_subject`, value: e.subject, apply: (v) => { mt.book_a_call_emails[i].subject = v } }))
  return slots.filter((s) => typeof s.value === 'string' && s.value.length > 0)
}

// Regenerate-path scrubbers: each guarantees the hook fields of one asset the
// per-unit regenerate produced, mutating + returning the same array.
export async function scrubTopicHooks(userId: string, topics: MtTopic[], chosenTopic: string, audience: unknown): Promise<MtTopic[]> {
  const slots: HookSlot[] = []
  topics.forEach((t, i) => {
    if (t.title) slots.push({ label: `topic_${i}_title`, value: t.title, apply: (v) => { topics[i].title = v } })
    if (t.angle) slots.push({ label: `topic_${i}_angle`, value: t.angle, apply: (v) => { topics[i].angle = v } })
  })
  await repairHookSlots(userId, slots, { chosen_topic: chosenTopic, audience })
  return topics
}

export async function scrubSlideCoverHook(userId: string, slides: MtSlide[], chosenTopic: string, audience: unknown): Promise<MtSlide[]> {
  const slots: HookSlot[] = []
  if (slides[0]?.slideTitle) slots.push({ label: 'cover_title', value: slides[0].slideTitle, apply: (v) => { slides[0].slideTitle = v } })
  await repairHookSlots(userId, slots, { chosen_topic: chosenTopic, audience })
  return slides
}

export async function scrubEmailSubjectHooks(userId: string, emails: MtEmail[], chosenTopic: string, audience: unknown): Promise<MtEmail[]> {
  const slots: HookSlot[] = []
  emails.forEach((e, i) => {
    if (e.subject) slots.push({ label: `subject_${i}`, value: e.subject, apply: (v) => { emails[i].subject = v } })
  })
  await repairHookSlots(userId, slots, { chosen_topic: chosenTopic, audience })
  return emails
}

// Stamp the as-generated { subject, body } snapshot on freshly generated emails
// so a later coach edit is detectable on read (mirrors slides' `original`). Called
// at generation time (full generate + regenerate), after any hook repair, so the
// snapshot is the final shipped copy. Does not touch an email that already carries
// an original, so a coach's stored snapshot is never overwritten.
export function stampEmailOriginals(emails: MtEmail[]): MtEmail[] {
  return emails.map((e) => (e.original ? e : { ...e, original: { subject: e.subject, body: e.body } }))
}

// Stamp the as-generated snapshot on freshly generated slides so a coach edit is
// detectable on read (customized_slides). Called at generation time (full generate
// + slides/script regenerate), after any hook repair, so the snapshot is the final
// shipped copy. Does not touch a slide that already carries a gen_snapshot, so a
// prior baseline is never overwritten. Separate from the editor-owned `original`,
// so the editor's reset-to-generated behavior is unaffected. Hand-added slides are
// never stamped, so they keep reading as customization.
export function stampSlideGenSnapshots(slides: MtSlide[]): MtSlide[] {
  return slides.map((s) =>
    s.gen_snapshot
      ? s
      : {
          ...s,
          gen_snapshot: {
            slideTitle: s.slideTitle,
            sectionName: s.sectionName,
            talkingPoints: [...s.talkingPoints],
            deliveryMove: { ...s.deliveryMove },
            script: s.script,
            speakerNote: s.speakerNote,
          },
        }
  )
}

// Stamp the as-generated snapshot on freshly generated call-script beats so a
// coach edit to the phrasing options / recommended line is detectable on read
// (customized_script). Called at generation time (full generate + sales_script
// regenerate). Does not touch a beat that already carries a gen_snapshot, so a
// prior baseline is never overwritten. A hand-added beat has none, so it reads as
// customization. Mirrors stampSlideGenSnapshots.
export function stampScriptGenSnapshots(beats: MtScriptBeat[]): MtScriptBeat[] {
  return beats.map((b) =>
    b.gen_snapshot
      ? b
      : { ...b, gen_snapshot: { beat: b.beat, prospect_mindset: b.prospect_mindset, phrasing_options: [...b.phrasing_options], recommended: b.recommended } }
  )
}

// Full generate — two waves so the downstream assets align to the FINAL title.
// Wave 1: meta first, fixing chosen_topic (+ subtitle). Wave 2: the remaining
// five units in parallel, grounded through withTitle(grounding, chosen_topic) —
// the same helper the regenerate path uses. Merged exactly as before. If any
// unit throws (including GenerationParseError), the whole generate fails so the
// caller returns an error rather than persisting a half-populated record.
export async function generateMicroTraining(
  userId: string,
  inputs: GeneratorInputs,
  // When keep_title pins the coach's angle, pass the pinned title + hook so the
  // whole training is generated on that angle (not the meta unit's fresh pick).
  pinned?: { chosen_topic: string; chosen_angle: string },
  // 'coach' when the pinned angle is a hook the coach wrote themselves — its
  // chosen_angle is then excluded from the banned-shape auto-repair so a
  // coach-authored hook is never silently rewritten. Defaults to 'ai'.
  angleSource: 'ai' | 'coach' = 'ai'
): Promise<MicroTraining> {
  const grounding = buildGrounding(inputs)

  // When keep_title pins the title, tell the meta unit the title is fixed so it
  // returns chosen_topic as that title and emits chosen_angle as the hook that
  // title opens from — no dependency on matching a pinned title against a freshly
  // regenerated topic list.
  const pinnedTitle = pinned?.chosen_topic?.trim() ? pinned.chosen_topic : ''
  const metaGrounding = pinnedTitle
    ? `${grounding}
The training title is fixed to: ${JSON.stringify(pinnedTitle)}. Return chosen_topic exactly as this title and emit chosen_angle as the hook this title opens from.`
    : grounding

  const metaPart = await runUnit(userId, 'meta', metaGrounding, inputs.voiceContext)
  const metaTopic = typeof metaPart.chosen_topic === 'string' ? metaPart.chosen_topic : ''
  const metaAngle = typeof metaPart.chosen_angle === 'string' ? metaPart.chosen_angle : ''
  const topics = Array.isArray(metaPart.topics) ? metaPart.topics : []

  // The angle every downstream asset stays inside. The meta unit now emits the
  // hook directly, so that is the primary source; fall back only when it is empty.
  // Never leave it empty (that would degrade withAngle to title-only and scatter
  // the assets).
  const chosenTopic = pinnedTitle || metaTopic
  const chosenAngle = pinnedTitle
    ? pinned!.chosen_angle.trim().length > 0
      ? pinned!.chosen_angle
      : metaAngle.trim().length > 0
        ? metaAngle
        : resolveAngle(topics, chosenTopic)
    : metaAngle.trim().length > 0
      ? metaAngle
      : resolveAngle(topics, metaTopic)

  // Wave 2: the remaining full-length units, plus the two net-new sales assets,
  // all bound to the selected ANGLE via withAngle. angle_previews is the one
  // exception — it produces copy for ALL topic options, so it stays on the
  // title-only grounding (withTitle) and must not be biased to the chosen angle.
  const rest: AssetUnit[] = ['slides', 'workbook', 'recording_tips', 'warm_invite', 'emails', 'book_a_call', 'sales_script', 'objections']
  const angledGrounding = withAngle(grounding, chosenTopic, chosenAngle)
  const restParts = await Promise.all([
    ...rest.map((u) => runUnit(userId, u, angledGrounding, inputs.voiceContext)),
    runUnit(userId, 'angle_previews', withTopics(withTitle(grounding, chosenTopic), topics), inputs.voiceContext),
  ])

  const merged = Object.assign({}, metaPart, ...restParts) as Partial<MicroTraining>
  const result: MicroTraining = {
    topics: merged.topics ?? [],
    chosen_topic: chosenTopic,
    chosen_angle: chosenAngle,
    subtitle: merged.subtitle ?? '',
    // The Micro-Training is always a 15-20 minute recorded video.
    total_duration: merged.total_duration ?? '15-20 minutes',
    outline: merged.outline ?? [],
    slides: merged.slides ?? [],
    workbook: merged.workbook ?? { title: '', intro: '', problem_intro: '', understanding: '', sections: [], keyTakeaways: [], recap: { started: '', did: '', first_part: '', stick: '' }, transformationClose: { before: '', after: '', bridge: '' }, closing_invite: { book_call: '', sell_program: '' } },
    warm_invite_emails: merged.warm_invite_emails ?? [],
    emails: merged.emails ?? [],
    book_a_call_emails: merged.book_a_call_emails ?? [],
    recording_tips: merged.recording_tips ?? [],
    sales_script: merged.sales_script ?? [],
    objections: merged.objections ?? [],
    angle_previews: merged.angle_previews ?? [],
  }
  // Deterministic safety net on the shipped hook fields — guarantees title,
  // angle, cover, topic titles/angles, and subjects are clean whatever the run did.
  // When the coach authored the pinned angle, its chosen_angle is left out so a
  // hook they typed is never auto-rewritten; every AI-generated hook still repairs.
  const repairSlots = collectFullHookSlots(result).filter(
    (s) => !(angleSource === 'coach' && s.label === 'chosen_angle')
  )
  await repairHookSlots(userId, repairSlots, { chosen_topic: result.chosen_topic, audience: inputs.audience })
  // Snapshot the final copy so a later coach edit is detectable on read.
  result.emails = stampEmailOriginals(result.emails)
  result.warm_invite_emails = stampEmailOriginals(result.warm_invite_emails)
  result.book_a_call_emails = stampEmailOriginals(result.book_a_call_emails)
  result.slides = stampSlideGenSnapshots(result.slides)
  result.sales_script = stampScriptGenSnapshots(result.sales_script)
  return result
}

// Regenerate a single asset unit bound to the current chosen angle (title +
// hook). Used by the per-asset regenerate path; returns only that unit's partial.
export async function regenerateAsset(
  userId: string,
  unit: AssetUnit,
  inputs: GeneratorInputs,
  chosenTopic: string,
  chosenAngle: string
): Promise<Partial<MicroTraining>> {
  return runUnit(userId, unit, withAngle(buildGrounding(inputs), chosenTopic, chosenAngle), inputs.voiceContext)
}

function withTitle(grounding: string, chosenTopic: string): string {
  return chosenTopic.trim().length > 0
    ? `${grounding}\nCURRENT TRAINING TITLE (align this asset to it): ${JSON.stringify(chosenTopic)}`
    : grounding
}

// Resolve the selected angle's hook text: the `angle` of the stored topic whose
// title matches chosenTopic (trimmed, case-insensitive). '' when none matches —
// the interim fallback for rows saved before chosen_angle was persisted.
export function resolveAngle(topics: MtTopic[], chosenTopic: string): string {
  const key = chosenTopic.trim().toLowerCase()
  if (!key) return ''
  const hit = topics.find((t) => t && typeof t.title === 'string' && t.title.trim().toLowerCase() === key)
  return hit && typeof hit.angle === 'string' ? hit.angle : ''
}

// The binding angle grounding injected into every asset unit: the selected
// title AND its hook/positioning text, with a firm instruction to open from and
// stay inside this hook rather than re-framing the blueprint. The blueprint
// supplies the problem/solution content; the angle is the fixed frame. Replaces
// withTitle everywhere an asset should stay on the coach's chosen angle.
function withAngle(grounding: string, chosenTopic: string, angleText: string): string {
  const title = chosenTopic.trim()
  const hook = angleText.trim()
  if (!title && !hook) return grounding
  return `${grounding}
TRAINING ANGLE (the fixed hook every asset opens from and stays inside — do not reframe the blueprint on your own):
- Title: ${title}
- Hook: ${hook}
The blueprint supplies the problem/solution content; the angle is the fixed frame you view it through. Open from this hook and keep the whole training on it.`
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
  chosenTopic: string,
  chosenAngle: string
): Promise<MtSlide[]> {
  const deck = currentSlides.map((s) => ({
    slideNumber: s.slideNumber,
    slideTitle: s.slideTitle,
    sectionName: s.sectionName,
    timing: s.timing,
  }))
  const grounding = `${withAngle(buildGrounding(inputs), chosenTopic, chosenAngle)}
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
  return currentSlides.map((s) => {
    const script = byNumber.get(s.slideNumber) ?? s.script
    // Keep the generator snapshot in step with the freshly generated script so a
    // script regenerate reads clean (not "customized"), while any prior edit to
    // the other fields still shows. Slides with no snapshot get one stamped by
    // stampSlideGenSnapshots at the call site.
    const gen_snapshot = s.gen_snapshot ? { ...s.gen_snapshot, script } : s.gen_snapshot
    return { ...s, script, gen_snapshot }
  })
}

// ── Add one slide ───────────────────────────────────────────────────────────
// Generates ONE polished slide from a coach personalize input, following the
// slide-deck doctrine for its beat and grounded in the coach's audience/framework
// so it fits the deck. Returns just the slide fields; no slideNumber (the editor
// assigns position on insert). Never touches the stored deck.
export type SingleSlideKind = 'proof' | 'opening_story' | 'signature_example'
type SingleSlide = Pick<MtSlide, 'slideTitle' | 'talkingPoints' | 'deliveryMove' | 'timing' | 'sectionName'>

const SINGLE_SLIDE_SPECS: Record<SingleSlideKind, { sectionName: string; label: string; instruction: string }> = {
  proof: {
    sectionName: 'Proof',
    label: 'PROOF TEXT',
    instruction: `Build an HONEST Proof slide built ONLY from the coach's PROOF TEXT below. Use only the results, names, numbers, and timeframes they wrote; invent nothing beyond their words. Attribute it exactly as they wrote it — the coach's own result stays first person, a client's result stays that client's.`,
  },
  opening_story: {
    sectionName: 'Cover',
    label: 'OPENING STORY',
    instruction: `Build an opening slide in the coach's OWN voice from their OPENING STORY below — weave it in as their own opening, teaching-first, preserving their words (frame around them, do not paraphrase them away).`,
  },
  signature_example: {
    sectionName: 'Teaching',
    label: 'SIGNATURE EXAMPLE',
    instruction: `Build a teaching slide that features the coach's SIGNATURE EXAMPLE below, worked in where it fits naturally, preserving their words. The slide must TEACH — the viewer can act on their own problem differently after it.`,
  },
}

export async function generateSingleSlide(
  userId: string,
  kind: SingleSlideKind,
  text: string,
  inputs: GeneratorInputs
): Promise<SingleSlide> {
  const spec = SINGLE_SLIDE_SPECS[kind]
  const grounding = buildGrounding(inputs)

  const prompt = `You write ONE polished slide for a coach's pre-recorded micro-training deck, following the slide-deck doctrine below. Produce a single slide that FITS the existing deck — grounded in the coach's audience and framework.

${SLIDES_CANONICAL}

${spec.instruction}

Return exactly ONE slide object (NO slideNumber — the editor assigns position):
{
  "slideTitle": "a full-sentence CONCLUSION under ~15 words (assertion-evidence), not a topic label",
  "talkingPoints": ["3-5 short beats the coach conveys in their OWN voice, ordered — what to say, not verbatim prose"],
  "deliveryMove": { "kind": "image | screen_share | just_talk", "note": "one short line: the move for this slide" },
  "timing": "minutes for this slide, e.g. '2 min'",
  "sectionName": "${spec.sectionName}"
}

Rules:
- Assertion-evidence: slideTitle is a full-sentence conclusion; the teaching lives in the talking points, never as an on-slide paragraph.
- talkingPoints are 3-5 short beats to CONVEY in the coach's own voice, in order, in the audience's language — beats to hit, not sentences to read verbatim and not a paragraph. Where it helps, make one point a delivery cue ("Pause here, let it land").
- deliveryMove is the ONE move for the slide. Choose kind HONESTLY and use all three where they fit: "image" when a static visual clearly strengthens the point; "screen_share" when showing something LIVE would land better than talking or a static picture (e.g. walking through a tool, document, worksheet, screenshot, or the coach's booking page); "just_talk" when saying it straight to camera is strongest. Do NOT default to one kind — reach for "screen_share" wherever a live demo genuinely fits, but never force it. note is one short line grounded in the coach's own framework or offer.
- sectionName MUST be exactly "${spec.sectionName}".
- Ground the slide in this blueprint and the audience's language so it fits the deck; recorded solo, no live-audience or "welcome to today's session" language.
${SHARED_RULES}`

  const system = inputs.voiceContext ? `${prompt}\n\n${inputs.voiceContext}` : prompt
  const userMessage = `${grounding}
COACH'S ${spec.label} (their words — the ONLY basis for the slide's substance): ${JSON.stringify(text)}

Generate the one slide now.`

  const parsed = await callAndParse(userId, system, userMessage, 2000)
  const sectionName = asString(parsed.sectionName).trim().length > 0 ? asString(parsed.sectionName) : spec.sectionName
  const dm = (parsed.deliveryMove && typeof parsed.deliveryMove === 'object' && !Array.isArray(parsed.deliveryMove) ? parsed.deliveryMove : {}) as Record<string, unknown>
  const dmKind = dm.kind === 'image' || dm.kind === 'screen_share' || dm.kind === 'just_talk' ? dm.kind : 'just_talk'
  return {
    slideTitle: asString(parsed.slideTitle),
    talkingPoints: asStringArray(parsed.talkingPoints).filter((t) => t.trim().length > 0),
    deliveryMove: { kind: dmKind, note: asString(dm.note) },
    timing: asString(parsed.timing),
    sectionName,
  }
}

export { GenerationParseError }
