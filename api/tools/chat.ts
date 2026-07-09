import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getSavedOutput, saveOutput } from '../../lib/savedOutputs'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from '../../lib/promptGuidelines'
import { logApiCost } from '../../lib/apiCostLog'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

type ToolType = 'audience' | 'transformation' | 'matcher'
type ChatMessage = { role: string; content: string }

// The frontend's actual request shape (confirmed via prod logs) is
// { tool_type, message, session_history } — a single new message plus prior
// turns — not the { messages: [...] } array this handler originally expected.
// Prefer `messages` as-is when present (nothing in prod logs has ever sent it,
// but don't break it if some future/other caller does), otherwise reconstruct
// it from session_history + message.
function normalizeMessages(body: Record<string, unknown>): ChatMessage[] | null {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages as ChatMessage[]
  }

  if (typeof body.message === 'string' && body.message.trim().length > 0) {
    const history = Array.isArray(body.session_history) ? body.session_history : []
    const priorTurns: ChatMessage[] = history
      .map((turn: unknown): ChatMessage | null => {
        if (turn && typeof turn === 'object' && typeof (turn as any).content === 'string') {
          const role = (turn as any).role === 'assistant' ? 'assistant' : 'user'
          return { role, content: (turn as any).content }
        }
        if (typeof turn === 'string') return { role: 'user', content: turn }
        return null
      })
      .filter((t): t is ChatMessage => t !== null)
    return [...priorTurns, { role: 'user', content: body.message }]
  }

  return null
}

const MAX_STEPS: Record<ToolType, number> = {
  audience: 8,
  transformation: 6,
  matcher: 2,
}

// Server-side "the session genuinely finished" signal, independent of the
// client-supplied current_step (which the frontend was not sending, so the
// stepComplete gate never fired). Checks the terminal fields of each tool's arc
// — fields that only appear once the conversation has reached its end (verified
// against production logs: absent on mid-conversation turns, present only on the
// completing turn). Used to set the stored `completed` flag as
// `stepComplete || hasTerminalFields(...)`, so completion tracking works today
// AND upgrades automatically once the frontend sends a numeric current_step.
function hasTerminalFields(toolType: ToolType, data: Record<string, unknown>): boolean {
  const filled = (k: string): boolean => typeof data[k] === 'string' && (data[k] as string).trim().length > 0
  switch (toolType) {
    case 'audience':
      // step-8 answer (triggering_moment) plus the closing hand-off field.
      return filled('triggering_moment') && filled('monetize_bridge')
    case 'transformation':
      return filled('after_state') && filled('the_bridge') && filled('proof_point')
    case 'matcher':
      // intake is done once they've answered: no existing offer, or its details.
      return data.has_existing_offer === false || filled('price') || filled('format')
    default:
      return false
  }
}

// The audience <data> block carries the full raw fields the model naturally
// produces (who_they_are, perceived_problem, tried_before, ...) — that raw
// object is the canonical saved record, consumed directly by the Funnel
// Builder's MTM Adapter. The report panel only knows how to render a
// narrower shape (painPoints/fearsAndDoubts/objections/dreamOutcome), so we
// derive that display subset deterministically here rather than asking the
// model to emit two parallel schemas, and merge it into the same object —
// nothing about the raw fields is dropped.
function deriveAudienceDisplayFields(raw: Record<string, unknown>): Record<string, unknown> {
  const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null)
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []

  // painPoints/fearsAndDoubts now come from the model's own inferred
  // pain_points/fears_and_doubts arrays — EXACTLY 5 rich entries each, where
  // every entry fuses the pain/fear itself with WHY it exists for this specific
  // person (same one-rich-string pattern as sales_objections). We fall back to
  // the older scalar-derived pair (perceived_problem/real_problem and
  // emotional_state/internal_dialogue) for early turns, before the analysis
  // fields have been inferred, so the cards still populate progressively.
  const painPointsRich = asStringArray(raw.pain_points)
  const painPoints =
    painPointsRich.length > 0
      ? painPointsRich
      : [asString(raw.perceived_problem), asString(raw.real_problem)].filter((v): v is string => v !== null)
  const fearsRich = asStringArray(raw.fears_and_doubts)
  const fearsAndDoubts =
    fearsRich.length > 0
      ? fearsRich
      : [asString(raw.emotional_state), asString(raw.internal_dialogue)].filter((v): v is string => v !== null)
  const dreamOutcome = asString(raw.dream_outcome)
  const avatarName = asString(raw.avatar_name)
  const problemStatement = asString(raw.problem_statement)
  // camelCase aliases for The Gap card. The model emits these as snake_case
  // (perceived_problem/real_problem) and they always have — but the Gap-card UI
  // reads output.perceivedProblem / output.realProblem, so the raw snake_case
  // keys never matched and the card rendered blank. The snake_case keys stay in
  // the record (via ...parsed) for the Funnel Builder's MTM Adapter; these are
  // additive camelCase copies the frontend can actually read.
  const perceivedProblem = asString(raw.perceived_problem)
  const realProblem = asString(raw.real_problem)
  // Short synthesis that frames the Pain Points / Fears cards — sums up what
  // this person is going through emotionally/practically and how to connect
  // with them. Inferred like dream_outcome, never asked directly.
  const connectionSummary = asString(raw.connection_summary)

  // New inferred insight layer — all synthesized from the conversation the same
  // way dream_outcome/avatar_name are, never asked as direct questions.
  // gapInsight is the tool's signature moment: it names WHY the gap between
  // perceived_problem and real_problem keeps this person stuck, so the coach
  // reading it about their own client feels the same "someone described my
  // problem better than I could" jolt the client feels in the conversation.
  const gapInsight = asString(raw.gap_insight)
  // Targeted subsets of the audience's own language — distinct from the
  // untouched language_they_use. languageProblem is their words for THE PROBLEM;
  // languageSolution is their words for what THEY THINK would fix it (their
  // imagined fix, which often won't match real_problem — that mismatch is itself
  // the insight).
  const languageProblem = asStringArray(raw.language_problem)
  const languageSolution = asStringArray(raw.language_solution)
  // 2-3 lightweight alternate framings of the core problem. Each is an object:
  // reframe (an alternate diagnostic angle, a genuine "you might think it's X,
  // but it could also be Y") plus a single-sentence monetization_hint teasing
  // that the angle could anchor its own Micro-Training. Kept deliberately shallow
  // — no urgency scoring, offer suggestions, or deep reasoning — so the Monetize
  // tool's later deep pass over the same territory doesn't feel redundant.
  //
  // Salvage, not all-or-nothing: the previous version required BOTH reframe and
  // monetization_hint on every entry and dropped the ENTIRE field if a single
  // entry (or a key-name/shape drift) failed, so one near-miss silently erased
  // the whole "Other Angles" card. Now each entry is salvaged independently:
  // accept common key-name drifts, accept a bare string as a reframe, keep an
  // entry as long as it carries the core content (the reframe) even if the hint
  // is missing, and only drop entries that have no usable reframe at all.
  // Output shape carries BOTH key spellings for the hint: the Gap-card UI reads
  // angle.monetizationHint (camelCase), while monetization_hint (snake_case) is
  // kept for the raw record / any snake_case consumer. reframe already matched
  // the UI, so it needs no alias.
  type Angle = { reframe: string; monetization_hint: string; monetizationHint: string }
  const asAngle = (a: unknown): Angle | null => {
    // A bare string entry (model flattened the array) → treat as the reframe.
    if (typeof a === 'string') {
      const r = a.trim()
      return r.length > 0 ? { reframe: r, monetization_hint: '', monetizationHint: '' } : null
    }
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return null
    const obj = a as Record<string, unknown>
    // Accept the documented key plus plausible near-miss aliases the model drifts to.
    const reframe = asString(obj.reframe) ?? asString(obj.angle) ?? asString(obj.reframing)
    const hint =
      asString(obj.monetization_hint) ??
      asString(obj.monetizationHint) ??
      asString(obj.monetization) ??
      asString(obj.hint) ??
      ''
    // Keep the entry if it has the core content; a hint with no reframe has
    // nothing to render, so it is dropped.
    return reframe !== null ? { reframe, monetization_hint: hint, monetizationHint: hint } : null
  }
  // Accept an array (normal) or a single object the model forgot to wrap.
  const rawAngles = Array.isArray(raw.other_angles)
    ? raw.other_angles
    : raw.other_angles && typeof raw.other_angles === 'object'
      ? [raw.other_angles]
      : []
  const otherAngles = rawAngles.map(asAngle).filter((a): a is Angle => a !== null)
  // One closing insight previewing the kind of Micro-Training this audience is
  // primed for — closes the Audience report and hands off toward Monetize.
  const monetizeBridge = asString(raw.monetize_bridge)

  // objections comes from the model's own inferred sales_objections field —
  // NOT from templating why_it_failed onto every tried_before entry, which
  // guaranteed near-duplicate output (one why_it_failed string repeated
  // across every past-attempt item). See ANALYSIS FIELDS in the audience
  // prompt for the generation rules.
  const objections = asStringArray(raw.sales_objections)

  // Straight renames — the model already produces these as arrays; no
  // combining logic needed, just pass through under the report panel's names.
  const pastAttempts = asStringArray(raw.tried_before)
  const buyingDecisions = asStringArray(raw.buying_triggers)
  const motivatingStatements = asStringArray(raw.motivating_phrases)
  const turnAwayStatements = asStringArray(raw.repelling_phrases)
  const whereToFind = asStringArray(raw.where_to_find_them)

  const derived: Record<string, unknown> = {}
  if (painPoints.length > 0) derived.painPoints = painPoints
  if (fearsAndDoubts.length > 0) derived.fearsAndDoubts = fearsAndDoubts
  if (objections.length > 0) derived.objections = objections
  if (dreamOutcome !== null) derived.dreamOutcome = dreamOutcome
  if (pastAttempts.length > 0) derived.pastAttempts = pastAttempts
  if (buyingDecisions.length > 0) derived.buyingDecisions = buyingDecisions
  if (motivatingStatements.length > 0) derived.motivatingStatements = motivatingStatements
  if (turnAwayStatements.length > 0) derived.turnAwayStatements = turnAwayStatements
  if (whereToFind.length > 0) derived.whereToFind = whereToFind
  if (avatarName !== null) derived.avatarName = avatarName
  if (problemStatement !== null) derived.problemStatement = problemStatement
  if (perceivedProblem !== null) derived.perceivedProblem = perceivedProblem
  if (realProblem !== null) derived.realProblem = realProblem
  if (connectionSummary !== null) derived.connectionSummary = connectionSummary
  if (gapInsight !== null) derived.gapInsight = gapInsight
  if (languageProblem.length > 0) derived.languageProblem = languageProblem
  if (languageSolution.length > 0) derived.languageSolution = languageSolution
  if (otherAngles.length > 0) derived.otherAngles = otherAngles
  if (monetizeBridge !== null) derived.monetizeBridge = monetizeBridge
  return derived
}

// TEMP diagnostic (paired with the response-body log in the handler). For the
// Gap-card fields that have been reported as never populating, this pins down —
// on a single real test turn — WHICH layer is losing each field, ending the
// generation-vs-derivation-vs-frontend ambiguity that log truncation blocked:
//   - ABSENT_IN_RAW      → the model never emitted it in the <data> block
//                          (generation / prompt-salience problem)
//   - DROPPED_IN_DERIVE  → present in raw, gone after derivation
//                          (a code/validation problem)
//   - present            → in the final structured_data the frontend receives;
//                          if the card is still empty, the problem is frontend
// It also captures the raw shape of other_angles verbatim, so any key-name or
// nesting drift the model produces is visible directly. Remove once the Gap
// card is confirmed populating.
function auditAudienceGapFields(
  raw: Record<string, unknown>,
  structured: Record<string, unknown>
): Record<string, string> {
  // rawKey → the key the frontend ultimately reads (derived camelCase where one
  // exists; perceived_problem/real_problem have none — they pass through as-is).
  const FIELDS: Array<[string, string]> = [
    ['perceived_problem', 'perceivedProblem'],
    ['real_problem', 'realProblem'],
    ['gap_insight', 'gapInsight'],
    ['language_problem', 'languageProblem'],
    ['language_solution', 'languageSolution'],
    ['other_angles', 'otherAngles'],
    ['connection_summary', 'connectionSummary'],
    ['monetize_bridge', 'monetizeBridge'],
  ]
  const has = (o: Record<string, unknown>, k: string): boolean => {
    const v = o[k]
    if (v == null) return false
    if (typeof v === 'string') return v.trim().length > 0
    if (Array.isArray(v)) return v.length > 0
    return true
  }
  const audit: Record<string, string> = {}
  for (const [rawKey, finalKey] of FIELDS) {
    const inRaw = has(raw, rawKey)
    const inFinal = has(structured, finalKey)
    audit[rawKey] = inFinal
      ? 'present'
      : inRaw
        ? 'DROPPED_IN_DERIVE'
        : 'ABSENT_IN_RAW'
  }
  return audit
}

const OPTIONS_INSTRUCTIONS = `
OPTIONAL ANSWER CHOICES:
Most of these questions are open-ended by design and must stay free-text — never add choices to a question that asks for a story, their own words, a specific example, or a personal explanation. Only when a question genuinely has a small, natural, enumerable set of answers (a frequency, a scale, a yes/no/something-else) should you offer clickable choices instead. Default to omitting this — most questions in this flow do not qualify.
When you do judge a question this way, end your response with this exact block on its own line, after your question text:
<options>["First choice", "Second choice", "Third choice"]</options>
Rules for this block:
- Only include it when multiple choice genuinely fits.
- List only the real choices. Never include "Other," "None of the above," or similar catch-alls — the interface adds that on its own.
- Keep each choice short (a few words), phrased the way the user would say it, not full sentences.
- Output valid JSON in the block — double-quoted strings only, no trailing commas.
- Do not mention this block or its format to the user.`

function noNarrationInstructions(exampleFields: string): string {
  return `
STRUCTURED DATA STAYS OUT OF THE VISIBLE MESSAGE:
The <data> block is a private machine-readable channel the frontend parses and strips before showing anything to the user — but your visible response text must independently stay completely clean of it too, since a leak in the visible text reaches the user regardless of what the frontend does with the block afterward. Never write out a field name from the schema above as plain text (for example: ${exampleFields}). Never paraphrase, list, preview, or summarize the contents of the <data> object in your visible response. Never describe what you are about to add to it, or narrate that you are building a report. Your visible response is only the natural conversational question or brief acknowledgment — nothing that reads like a field dump, a JSON fragment, or a report summary.`
}

// Builds a specific, content-grounded recap of the Audience Profile (Step 1:
// Attract) for the Transform prompt to continue from — avatar name + the core
// problem + the already-known before-state, so Transform can reference it by
// name and build on it instead of re-asking cold. Returns null (→ Transform
// falls back to a standalone conversation) unless there's a real avatar to
// build on; avatar_name is Step 1's strongest continuity signal.
function buildAudienceRecap(p: Record<string, unknown> | null): { recap: string; avatarName: string } | null {
  if (!p) return null
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null)
  const avatarName = s(p.avatar_name)
  if (!avatarName) return null
  const problem = s(p.problem_statement) || s(p.real_problem) || s(p.perceived_problem)
  const who = s(p.who_they_are)
  const feeling = s(p.emotional_state)
  const selfTalk = s(p.internal_dialogue)
  const dream = s(p.dream_outcome)
  const lines = [`- Avatar (refer to them by this name): ${avatarName}`]
  if (who) lines.push(`- Who they are: ${who}`)
  if (problem) lines.push(`- Their core problem: ${problem}`)
  if (feeling) lines.push(`- How they feel in the before state: ${feeling}`)
  if (selfTalk) lines.push(`- Their inner self-talk in the before state: ${selfTalk}`)
  if (dream) lines.push(`- What they ultimately want: ${dream}`)
  return { recap: lines.join('\n'), avatarName }
}

function buildSystemPrompt(
  toolType: ToolType,
  currentStep: number,
  audienceProfile: Record<string, unknown> | null = null
): string {
  switch (toolType) {
    case 'audience':
      return `You are a sharp, empathetic business strategist helping a coach discover who they truly serve at a level deeper than they have ever gone before. Your job is not to fill out a profile — it is to excavate real insight. You ask ONE question at a time. You are warm but direct. No flattery, no filler, no bullet-point summaries after every answer. Just a focused conversation that goes somewhere.

This is an open-ended conversation, not a fixed questionnaire — there is no fixed number of turns. But most of the report's fields (see ANALYSIS FIELDS below) are YOUR OWN synthesis, not things the coach needs to tell you directly — needing more of those filled in is never a reason to ask another question. The conversational themes below are the only things you actually need the coach to answer, and each one only needs ONE substantive, specific answer. Two real signals to keep going: a theme has not yet been substantively covered, or an answer was vague/surface-level and a follow-up would get something concrete. The moment neither is true — every theme has at least one specific, concrete answer on the table — that is your signal to stop asking and start synthesizing, not a cue to keep probing for more raw material.

REDUNDANCY IS YOUR STOP SIGNAL, NOT A REASON TO KEEP GOING: before asking your next question, check whether the coach has already substantively answered it — even indirectly, as part of a different answer, in a different form, or as a tangent. If they have, do not ask it again to hear it restated or reconfirmed. If the only questions left in your head are ones that would just re-ask something already known, that means you are done gathering — move toward wrapping up and let your own analysis fill the rest of the report, rather than manufacturing another question for its own sake.

Cover this arc of themes, one question at a time, roughly in this order — but linger on any theme that needs more depth, and follow up as many times as it takes to get something real:
- Who they work with, in their own words — no pressure to get it perfect.
- Their best client ever — that person's situation when they first came to them.
- The first words out of that client's mouth describing the problem — their actual language, not how the coach would explain it.
- Why that client thought they had the problem — their own explanation for being stuck.
- What they had already tried before finding them, and what happened when they tried it.
- What was actually going on underneath, in the coach's opinion — the real reason they were stuck, beyond what they said.
- Their day-to-day life while dealing with this — what they were feeling, thinking, telling themselves.
- What finally pushed them to reach out and do something about it — the moment or event that made them decide enough was enough.

Once every theme has a specific, concrete answer, wrap up and let your own analysis fill the rest of the report — do not keep asking questions just to gather more raw material for the analysis fields; synthesizing those is your job, not something the coach needs to hand you piece by piece. Depth on a genuinely thin theme is the goal; more questions after every theme is already answered is not.

CRITICAL RULES:
- Ask exactly one question at a time. Never stack two questions.
- Never summarize or recap what they said back to them — just move forward.
- If they give a vague or surface-level answer, go deeper before moving on. Ask for more specifics or offer an example.
- Before asking a question, check whether it would just restate or re-confirm something the coach already substantively told you, even in different words or as part of a different answer. If so, do not ask it — that repetition is itself a sign you have covered enough, not a reason to keep probing.
- If they say they do not know or cannot answer, NEVER leave them stuck. Do one of three things:
  1. Make it more specific: ask them to think of one real client and describe that person's specific situation.
  2. Offer prompted options: Would you say it is more like A, B, or something else entirely?
  3. Draw from what they have already said: Based on what you told me earlier it sounds like it might be X — does that resonate?
- Your goal is that no one finishes this conversation without clear specific answers — even if you helped surface them.
- Do not introduce yourself or explain what you are doing. Start with the first question immediately.
- Keep responses short. One question, maybe one sentence of context if absolutely needed.
${OPTIONS_INSTRUCTIONS}

PROGRESSIVE REPORT DATA:
Build the user's report incrementally — after EVERY answer, not just at the end, include a <data> block with every field you are currently confident about, based on everything said so far in the conversation.

Rules:
- Cumulative, not incremental: each <data> block must contain ALL fields you are confident about so far, not just what's new this turn. The frontend simply overwrites its stored report with your latest block, so dropping a field you already knew would erase it from the report.
- Omit any field you do not yet have real substance for — never include it as an empty string, empty array, or null. Add a field only once you actually have something specific to put in it.
- If you do not have confident content for any field yet, omit the <data> block entirely for that turn — do not send an empty one.
- Do not force fields early. Early turns having no <data> block, or one with only 1-2 fields, is expected and correct.
- Output valid JSON with double-quoted strings only, no trailing commas. Do not mention this block or its format to the user.
${noNarrationInstructions('buying_triggers, motivating_phrases, repelling_phrases, pain_points, fears_and_doubts, connection_summary, gap_insight, language_problem, language_solution, other_angles, monetize_bridge, where_to_find_them, sales_objections, avatar_name, problem_statement, dream_outcome')}
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}

<data>
{
  "who_they_are": "specific description of the person not a category",
  "their_world": "the context and environment they operate in",
  "emotional_state": "how they feel day to day while dealing with this",
  "internal_dialogue": "the actual words and thoughts running through their head",
  "perceived_problem": "what they think is wrong their own explanation",
  "real_problem": "what is actually going on underneath the root cause",
  "tried_before": ["specific thing they tried", "another thing they tried"],
  "why_it_failed": "the real reason those attempts did not work",
  "language_they_use": ["exact phrase they use", "another phrase", "how they would search for help"],
  "triggering_moment": "the specific event or moment that made them finally take action",
  "dream_outcome": "what they actually want their life or business to look like",
  "buying_triggers": ["a specific moment or realization likely to push this audience toward buying", "a second distinct trigger", "a third distinct trigger"],
  "motivating_phrases": ["a specific phrase or angle likely to motivate this audience to act", "a second, genuinely distinct angle", "a third", "and so on — EXACTLY 10 distinct entries, no repeated boilerplate"],
  "repelling_phrases": ["a specific phrase or positioning likely to lose this audience's trust", "a second, genuinely distinct one", "a third", "and so on — EXACTLY 10 distinct entries, no repeated boilerplate"],
  "pain_points": ["a specific pain this person feels, fused with WHY it exists for them — rooted in a concrete detail from the conversation", "a second, genuinely distinct pain with its own distinct why", "a third distinct entry", "a fourth distinct entry", "a fifth distinct entry"],
  "fears_and_doubts": ["a specific fear or doubt this person carries, fused with WHY they carry it — rooted in a concrete detail from the conversation", "a second, genuinely distinct fear with its own distinct why", "a third distinct entry", "a fourth distinct entry", "a fifth distinct entry"],
  "where_to_find_them": ["a specific platform, community, or content type this audience likely spends time in"],
  "sales_objections": ["a specific sales-resistance thought this audience would have, paired with why MTM's process specifically dissolves it", "a second, genuinely distinct entry — different resistance, different resolving detail", "a third distinct entry", "a fourth distinct entry", "a fifth distinct entry"],
  "avatar_name": "an invented persona name for the ideal client, e.g. 'Sarah the Overwhelmed Coach'",
  "problem_statement": "a single punchy distilled sentence combining who this person is and their core problem",
  "connection_summary": "2-3 sentences summing up what this person is going through emotionally and practically as a whole, plus a brief note on how to connect with them — framing context that sits above the pain points and fears",
  "gap_insight": "2-3 sentences naming WHY the gap between perceived_problem and real_problem keeps this person stuck, and why naming that gap — not more tactics — is what actually moves them",
  "language_problem": ["the audience's own words describing THEIR PROBLEM", "another problem-phrase in their voice"],
  "language_solution": ["the audience's own words for what THEY THINK would fix it — their imagined solution, not the real one", "another imagined-fix phrase in their voice"],
  "other_angles": [{ "reframe": "an alternate diagnostic angle on this same person — 'you might think it's X, but it could also be Y'", "monetization_hint": "one light sentence flagging this angle could anchor its own Micro-Training" }],
  "monetize_bridge": "1-2 sentences previewing what kind of Micro-Training this specific audience is primed for — closes the report and hands off toward Monetize"
}
</data>

ANALYSIS FIELDS (buying_triggers, motivating_phrases, repelling_phrases, pain_points, fears_and_doubts, connection_summary, gap_insight, language_problem, language_solution, other_angles, monetize_bridge, where_to_find_them, sales_objections, avatar_name, problem_statement):
These are NOT questions to ask the user — never ask about them directly, the same way dream_outcome is never asked directly. They are your own analysis, synthesized from everything already discussed. Only include each once you have enough context to say something specific and non-generic — typically once the conversation has real depth, same timing as dream_outcome, EXCEPT avatar_name and problem_statement (see below), which don't need that much depth.
- buying_triggers: reason about SEVERAL distinct likely buying decision points for this audience — do not just wrap triggering_moment in a single-item array. Draw on real_problem, emotional_state, and triggering_moment to identify multiple genuine moments or realizations that would push this audience toward buying, not just the one moment they already described.
- motivating_phrases: EXACTLY 10 entries — specific phrases or angles that would motivate this audience to act, drawn from language_they_use, emotional_state, internal_dialogue, and dream_outcome — language they would actually respond to, not generic encouragement. Each of the 10 must be genuinely different from the others — a different angle, emotion, or piece of their language — no repeated boilerplate or trivial rewordings, held to the same distinctness standard as sales_objections.
- repelling_phrases: EXACTLY 10 entries — the inverse of motivating_phrases — specific phrases or positioning that would repel this audience or lose their trust, inferred the same way. Each of the 10 must be genuinely distinct, same no-boilerplate standard as motivating_phrases and sales_objections.
- pain_points: EXACTLY 5 entries, each a single rich string that fuses the pain itself with WHY that pain exists for THIS specific person — not a generic surface pain, but reasoned from a concrete detail already in the conversation (perceived_problem, real_problem, emotional_state, internal_dialogue, tried_before, their_world). Same one-rich-string pattern as sales_objections: state the pain, then in the same string explain the specific reason it exists for them. Each of the 5 must draw on a DIFFERENT specific detail so no two share the same root — no generic, interchangeable pains.
- fears_and_doubts: EXACTLY 5 entries, each a single rich string that fuses the fear or doubt with WHY this person carries it — rooted in something specific from the conversation (emotional_state, internal_dialogue, tried_before, why_it_failed, real_problem), not a generic fear. Same one-rich-string pattern as pain_points and sales_objections: state the fear, then in the same string explain the specific reason they hold it. Each of the 5 must draw on a DIFFERENT specific detail so no two share the same root.
- connection_summary: 2-3 sentences, inferred the same way as dream_outcome (never asked directly, only once you have enough context — typically once the conversation has real depth). Two jobs in one short block: (1) sum up what this person is going through emotionally AND practically as a whole — the felt experience, not a restatement of any single pain or fear; (2) close with a brief note on how to genuinely connect with them (the tone, the angle, what makes them feel understood). This is the framing context that sits ABOVE the pain points and fears cards, so keep it holistic and human — a synthesis, not a list, and distinct from the specific pain_points/fears_and_doubts entries beneath it.
- gap_insight: 2-3 sentences, inferred like dream_outcome (never asked directly, only once you have real depth in the conversation). This is the tool's SIGNATURE MOMENT — name WHY the gap between perceived_problem (what they think is wrong) and real_problem (what's actually going on) is exactly what keeps this person stuck, and why naming that gap — not piling on more tactics — is what actually moves them. Write it so the coach reading it about their own client feels the same "someone just described my problem better than I could" jolt the client feels in the conversation. Specific to THIS person's perceived_problem/real_problem gap, not a generic "root cause matters" platitude.
- language_problem: the audience's OWN words and phrases describing THEIR PROBLEM specifically — a targeted subset in their actual voice, distinct from language_they_use (which is broader and stays as-is). Only the problem-language: how they'd say what's wrong, not how the coach would frame it.
- language_solution: the audience's own words for what THEY THINK would fix it — their IMAGINED solution, in their voice. This is what they believe the answer is, which often will NOT match real_problem; surface it honestly even when (especially when) it's misaligned, because that mismatch between what they think fixes it and what actually would is itself insight.
- other_angles: EXACTLY 2-3 entries, each an object {"reframe": "...", "monetization_hint": "..."}. reframe is an alternate diagnostic angle on this SAME person — a genuine "you might be reading it as X, but it could also be Y" that's meaningfully different from real_problem and from the other angles (same distinctness standard as sales_objections — no restatements of each other or of the primary diagnosis). monetization_hint is ONE LIGHT SENTENCE flagging that this angle could anchor its own Micro-Training — a teaser only. Keep these DELIBERATELY SHALLOW: no urgency scoring, no offer suggestions, no deep reasoning paragraph. They must stay lighter than the Monetize tool's Top 10, or Monetize's later deep pass over the same territory will feel redundant to the member.
- monetize_bridge: 1-2 sentences, the closing insight of the whole report. Preview what kind of Micro-Training THIS specific audience is primed for, given everything surfaced — a natural hand-off that points the member toward the Monetize tool. Keep it a single forward-looking nudge, not a list of offers.
- where_to_find_them: specific platforms, communities, or content types this audience likely spends time in, inferred from who_they_are, their_world, and language_they_use.
- sales_objections: EXACTLY 5 entries, each a single string with two parts joined by " — ": (1) a specific, plausible sales-resistance thought this audience would actually have about buying coaching from THIS person, rooted in their specific story — reasoned from emotional_state, internal_dialogue, perceived_problem, and real_problem, not a generic "it's expensive" objection; (2) a brief clause on why the MTM discovery process specifically dissolves that exact resistance. You may use why_it_failed as supporting context/flavor for why past attempts didn't land, but never templating it verbatim onto every entry — each of the 5 must draw on a DIFFERENT specific detail from the conversation (a different fear, a different phrase, a different past attempt, a different piece of their internal dialogue), so no two entries share the same root cause or trailing explanation. This is a completely different question from why_it_failed/tried_before: it is not "why did their past unrelated purchases fail," it is "why would a prospect specifically resist buying from this person, and what dissolves that."
- avatar_name: an invented first name plus a short descriptor capturing this audience's core identity or struggle, in the style of "Sarah the Overwhelmed Coach" — a fictional composite representing the audience, not the real name of any client the coach mentioned. Include this as soon as who_they_are is established enough to name a persona — early on, well before the deeper analysis fields.
- problem_statement: one punchy sentence — not a paragraph — combining who this person is and their core problem, synthesized from who_they_are and perceived_problem (draw on real_problem too if it sharpens the line). Example: "A coach stuck in the friend zone, giving away expertise for free instead of charging what they're worth." Include this once who_they_are and perceived_problem are both established — early on, same timing as avatar_name.`
    case 'transformation': {
      // Shared tail — the report instructions + <data> schema, identical for
      // the continuity and standalone variants.
      const DATA_TAIL = `Once you have enough specific information — typically after the first few themes — include a JSON object at the end of your response wrapped in <data> tags. Output valid JSON with double quotes only. Do not mention the data tags to the user.
${noNarrationInstructions('before_state, the_bridge, proof_point')}
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}

<data>
{
  "before_state": "vivid description of where the client is before — situation emotions circumstances",
  "before_internal_talk": "the specific words and thoughts running through their head in the before state",
  "before_results": "what their life or business actually looks like before — concrete and specific",
  "after_state": "vivid description of where the client is after — situation emotions circumstances",
  "after_internal_talk": "the specific words and thoughts running through their head in the after state",
  "after_results": "what their life or business actually looks like after — concrete and specific",
  "the_bridge": "what the coach does that creates this shift — their unique approach in plain language",
  "proof_point": "a specific real client result or story that demonstrates the transformation",
  "client_language_before": "exact words or phrases the client uses to describe themselves before",
  "client_language_after": "exact words or phrases the client uses to describe themselves after"
}
</data>`

      const rec = buildAudienceRecap(audienceProfile)

      // CONTINUITY PATH — a completed Audience Profile exists, so Transform picks
      // up from Step 1: Attract by name instead of starting cold.
      if (rec) {
        return `You are a direct insightful coach helping this coach articulate the transformation they create — building directly on the Audience Profile they already completed in Step 1: Attract. Do NOT start cold, and do NOT re-gather what Step 1 already established. Most coaches can describe their methods but struggle to describe the shift — the before and after — in a way that makes a prospect feel seen and ready to buy. Pull that out through focused conversation. One question at a time. Warm but no fluff.

FROM STEP 1: ATTRACT — this coach's ideal client, already captured in their Audience Profile. Reference it specifically, by name; do not re-ask it:
${rec.recap}

YOUR FIRST MESSAGE (there are no prior turns yet):
Do NOT ask a transformation question yet. Instead:
1. Recap ${rec.avatarName} and their core problem in one or two specific sentences, in your own words, grounded in the Audience Profile above — e.g. "Looking back at your Audience Profile, ${rec.avatarName} was dealing with…". Name the avatar and the real problem; never a generic "in the last step you…".
2. Then ask the coach to confirm ${rec.avatarName} is still the right person to build this transformation around before you go deeper.
End that first message with exactly this block: <options>["Yes, that's them", "Let me adjust"]</options>
If the coach says to adjust, briefly capture what's different about the avatar, then continue the same way using the adjusted picture.

CONFIRMATION RESOLVES IN ONE TURN — ASK ONCE, THEN MOVE ON: whatever the coach says in their very next reply counts as confirming the avatar, UNLESS they explicitly say it is not the right person, express real doubt, or ask to change/adjust the avatar. If they answer with "Yes, that's them" — proceed. If they instead launch straight into substantive content (describing a client, answering as though you'd already asked the first transformation question, or anything that is not a clear pushback) — that is ALSO confirmation, just implicit. Treat their answer as both the confirmation AND the first real answer of the conversation: do not thank them for confirming and then re-ask "is this still them" again, do not ask for confirmation a second time, and do not stall the conversation waiting for an explicit "yes." One confirmation attempt is enough. Only stay on confirmation if they actually contradict or question the avatar.

AFTER the avatar is confirmed:
- Refer to the client as ${rec.avatarName} throughout the rest of the conversation — never "your client" or "the client".
- The BEFORE state (their situation, how they feel, their self-talk) is already known from Step 1. Do NOT re-ask it cold. Build on it — reference what's established and only ask to fill a genuine gap or sharpen a specific detail.
- Spend your questions on what Step 1 did NOT cover, the parts that make a transformation story: where ${rec.avatarName} ends up (the after state and their new self-talk), the specific bridge this coach provides to get them there, a concrete proof point or real result, and the exact language ${rec.avatarName} uses about themselves afterward.

This is an open-ended conversation, not a fixed questionnaire. Take as many questions as you genuinely need — there is no fixed number of turns. The ONLY signal to stop is when every report field below is filled with something specific and non-generic. If an answer is generic or a thread is still thin, keep pulling on it before moving on.

Cover this arc, one question at a time — but the before-state is already known from Step 1, so weight your questions toward the after, the bridge, and the proof:
- (already known from Step 1 — only confirm or sharpen, don't re-ask cold) where ${rec.avatarName} starts: situation, feelings, self-talk.
- What actually changes for ${rec.avatarName} after working with this coach — situation, confidence, results.
- What ${rec.avatarName} believed before that they no longer believe after.
- A specific win for a client like ${rec.avatarName}, even a small one — what happened, in the client's own words.
- How ${rec.avatarName} would describe where they are now versus before if telling a friend.
- What it is about this coach's approach that makes the shift possible — what they do differently from everything ${rec.avatarName} already tried.
- What ${rec.avatarName} would tell their six-months-ago self.

CRITICAL RULES:
- Ask exactly one question at a time. Never stack two questions.
- After the opening recap-and-confirm, never summarize the coach's own answers back to them — just move forward.
- If they give a generic answer like they feel more confident, push for specificity: What does that actually look like? Give me a real example.
- If they say they do not know or cannot answer, NEVER leave them stuck. Do one of three things:
  1. Make it more specific: Think about one real client like ${rec.avatarName} — what changed for them specifically?
  2. If they have no client examples yet, pivot: Think about your own journey — what shifted for you when you figured this out? Your story is a valid proxy.
  3. Offer prompted options based on what they have shared.
- Your goal is that no one finishes without a clear vivid picture of the transformation they create for ${rec.avatarName}.
- Do not introduce yourself or explain what you are doing.
- Keep responses short. One question, maybe one sentence if absolutely needed.
${OPTIONS_INSTRUCTIONS}

${DATA_TAIL}`
      }

      // STANDALONE FALLBACK — no Audience Profile to build on (e.g. Transform
      // opened before Attract was completed). Runs as a self-contained arc.
      return `You are a direct insightful coach helping someone articulate the transformation they create for their clients. Most coaches can describe their methods but struggle to describe the shift — the before and after — in a way that makes someone feel seen and ready to buy. Your job is to pull that out of them through focused conversation. One question at a time. Warm but no fluff.

This is an open-ended conversation, not a fixed questionnaire. Take as many questions as you genuinely need to gather full, specific context — there is no fixed number of turns, and no need to rush toward wrapping up. The ONLY signal to stop is when you have enough to articulate a complete, vivid transformation — every report field below filled with something specific and non-generic — not a question count. If an answer is generic or a thread is still thin, keep pulling on it before moving on.

Cover this arc of themes, one question at a time, roughly in this order — but linger on any theme that needs more depth, and follow up as many times as it takes to get something real:
- What actually changes for a client after working with them — not what they teach but what is different about the client's situation, confidence, and results.
- What the client believed about themselves or their situation before that they no longer believe after — what shifted in how they see things.
- A specific client win, even a small one — what happened, and what the client said changed for them in their own words.
- How that client would describe where they are now versus where they were before if they were telling a friend — what words would they use.
- What it is about their approach that makes this transformation possible — what they do differently from everything else the client tried.
- What someone who just finished working with them would say if they ran into their old self from six months ago — what they would want that person to know.

Once these themes are covered richly enough to fill the report, you may ask a few more questions to sharpen anything still thin — then deliver the complete picture. Depth is the goal, not speed.

CRITICAL RULES:
- Ask exactly one question at a time. Never stack two questions.
- Never summarize or recap what they said back to them — just move forward.
- If they give a generic answer like they feel more confident, push for specificity: What does that actually look like? Give me a real example.
- If they say they do not know or cannot answer, NEVER leave them stuck. Do one of three things:
  1. Make it more specific: Think about one client — what changed for them specifically?
  2. If they have no client examples yet, pivot: Think about your own journey — what shifted for you when you figured this out? Your story is a valid proxy.
  3. Offer prompted options based on what they have shared.
- Your goal is that no one finishes this conversation without a clear vivid picture of the transformation they create.
- Do not introduce yourself or explain what you are doing. Start with the first question immediately.
- Keep responses short. One question, maybe one sentence if absolutely needed.
${OPTIONS_INSTRUCTIONS}

${DATA_TAIL}`
    }
    case 'matcher':
      return `You are gathering a coach's current business context before matching them with monetizable problems. This is a quick intake, not a deep conversation — do not probe, do not go deeper, just get the two answers below.

You are on step ${currentStep} of 2.

Follow this arc:
Step 1: If this is the first message of the conversation, open with ONE brief line making clear this is combining with everything already known from their Audience Profile and Transformation — not just these 2 questions in isolation — then ask whether they currently have a coaching or consulting offer right now, in the same message. Keep that opening line to a single sentence; do not explain the process further.
(If this is not the first message, skip straight to the step below — do not repeat the opening line.)
Step 2:
- If they answered yes on step 1: ask what they charge, what format it is (1:1 coaching, group, consulting, or course), and how they deliver it (calls, async, cohort, etc.) — one combined question, not three separate ones.
- If they answered no on step 1: do not ask a new question. Briefly acknowledge and let them know you have what you need to move on to matching them with problems.

CRITICAL RULES:
- Do not introduce yourself or explain what you are doing beyond the single opening line in step 1 (first message only). Start the actual question immediately after it.
- Keep it brief. This is a quick intake, not a discovery session — no follow-up probing, no going deeper on their answer.
- Step 1 is a yes/no question — always include <options>["Yes", "No"]</options> with it.
${OPTIONS_INSTRUCTIONS}

DATA:
Include a <data> block once you know the step 1 answer, and again (updated) after step 2 if applicable. Output valid JSON with double-quoted strings only. Do not mention this block to the user.
${noNarrationInstructions('has_existing_offer, price, format')}
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}

If they have no existing offer:
<data>
{ "has_existing_offer": false }
</data>

If they have an existing offer:
<data>
{ "has_existing_offer": true, "price": "what they charge", "format": "1:1 coaching, group, consulting, or course", "delivery": "how they deliver it" }
</data>`
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Tier gate — AI generation requires a paid membership tier
  const { data: gateUser } = await supabase
    .from('users')
    .select('membership_tier')
    .eq('id', userId)
    .single()
  if (!gateUser || !['low_ticket', 'full'].includes(gateUser.membership_tier)) {
    return res.status(403).json({ error: 'upgrade_required' })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const { tool_type, current_step } = body

  if (tool_type !== 'audience' && tool_type !== 'transformation' && tool_type !== 'matcher') {
    console.warn('[tools/chat] 400 invalid tool_type', {
      path: req.url,
      tool_type,
      body_keys: Object.keys(body),
    })
    return res.status(400).json({ error: 'Invalid tool_type' })
  }

  const messages = normalizeMessages(body)
  if (!messages || messages.length === 0) {
    console.warn('[tools/chat] 400 messages required', {
      path: req.url,
      messages_type: Array.isArray(body.messages) ? `array(${(body.messages as unknown[]).length})` : typeof body.messages,
      message_type: typeof body.message,
      session_history_type: Array.isArray(body.session_history) ? `array(${(body.session_history as unknown[]).length})` : typeof body.session_history,
      body_keys: Object.keys(body),
    })
    return res.status(400).json({ error: 'messages array required' })
  }
  if (body.message !== undefined) {
    console.info('[tools/chat] normalized message+session_history', {
      tool_type,
      reconstructed_count: messages.length,
      session_history_type: Array.isArray(body.session_history) ? `array(${(body.session_history as unknown[]).length})` : typeof body.session_history,
    })
  }
  const currentStep = typeof current_step === 'number' ? current_step : 1

  try {
    // Transform builds on Step 1: Attract — load the saved Audience Profile so
    // the prompt can recap the avatar by name and continue from it rather than
    // re-asking cold. Best-effort: any failure (or no audience yet) falls back
    // to the standalone Transform conversation. Named fields are read from the
    // flat content; session_history/completed are simply ignored.
    let audienceProfile: Record<string, unknown> | null = null
    if (tool_type === 'transformation') {
      try {
        const aud = await getSavedOutput(userId, 'audience')
        if (aud?.content && typeof aud.content === 'object' && !Array.isArray(aud.content)) {
          audienceProfile = aud.content as Record<string, unknown>
        }
      } catch (audErr) {
        console.error('[tools/chat] audience profile fetch for transformation continuity', audErr)
      }
    }

    const system = buildSystemPrompt(tool_type, currentStep, audienceProfile)

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      // The audience schema has grown to ~25 fields, several requiring large
      // multi-entry arrays of full sentences (motivating_phrases and
      // repelling_phrases are 10 distinct entries each; pain_points,
      // fears_and_doubts, and sales_objections are 5 rich entries each) plus
      // several multi-sentence insight fields (gap_insight, connection_summary,
      // other_angles objects, monetize_bridge) — a tight cap risks
      // late-conversation turns getting cut off mid-<data>-block, leaving the
      // closing tag unwritten and the raw JSON fragment leaking straight into
      // the visible message. Sized generously to fit the fullest final-step
      // block with headroom.
      max_tokens: 6000,
      thinking: { type: 'disabled' },
      system,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    })

    // Same tool_type -> saved-output key mapping used below for saveToolType
    // (matcher's intake is logged under 'matcher_intake', not the retired
    // bare 'matcher' key).
    await logApiCost(
      userId,
      tool_type === 'matcher' ? 'matcher_intake' : tool_type,
      'claude-sonnet-5',
      message.usage.input_tokens,
      message.usage.output_tokens
    )

    const responseText = message.content[0]?.type === 'text' ? message.content[0].text : ''

    // Extract <data>...</data> JSON if present, then strip the tags from the message
    let structuredData: unknown = null
    let cleanedMessage = responseText
    const dataMatch = responseText.match(/<data>([\s\S]*?)<\/data>/)
    if (dataMatch) {
      try {
        const parsed = JSON.parse(dataMatch[1].trim())
        if (tool_type === 'audience' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const rawParsed = parsed as Record<string, unknown>
          const merged = { ...rawParsed, ...deriveAudienceDisplayFields(rawParsed) }
          structuredData = merged
          // TEMP: field-level audit of the Gap-card fields (see
          // auditAudienceGapFields). Logs raw other_angles verbatim so any
          // shape/key drift is visible. Remove once the card is confirmed.
          console.log('[tools/chat] TEMP audience Gap-field audit', {
            current_step: currentStep,
            gap_field_status: auditAudienceGapFields(rawParsed, merged),
            other_angles_raw: rawParsed.other_angles ?? null,
          })
        } else {
          structuredData = parsed
        }
      } catch {
        structuredData = null
      }
      cleanedMessage = cleanedMessage.replace(/<data>[\s\S]*?<\/data>/, '').trim()
    } else {
      // Defense in depth: a <data> tag opened but never found a matching
      // close (most likely the completion got cut off mid-JSON) means this
      // turn's structured data is unrecoverable — but we can still stop the
      // raw, unclosed JSON fragment from leaking into the visible message.
      // Losing this turn's <data> silently is far better than showing the
      // user a JSON dump.
      const danglingIndex = cleanedMessage.indexOf('<data>')
      if (danglingIndex !== -1) {
        console.warn('[tools/chat] dangling unclosed <data> tag stripped', {
          tool_type,
          current_step: currentStep,
          stop_reason: message.stop_reason,
          response_text_length: responseText.length,
        })
        cleanedMessage = cleanedMessage.slice(0, danglingIndex).trim()
      }
    }

    // Extract <options>[...]</options> JSON array if present (multiple-choice turns only),
    // then strip the tags from the message. Malformed or empty blocks are treated as no options.
    let options: string[] | null = null
    const optionsMatch = responseText.match(/<options>([\s\S]*?)<\/options>/)
    if (optionsMatch) {
      try {
        const parsed = JSON.parse(optionsMatch[1].trim())
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((o) => typeof o === 'string')) {
          options = parsed
        }
      } catch {
        options = null
      }
      cleanedMessage = cleanedMessage.replace(/<options>[\s\S]*?<\/options>/, '').trim()
    }

    // Defensive fallback: on rare turns the model's entire raw output is just
    // tag content (a <data> and/or <options> block) with no surrounding prose
    // at all — verified this is not a stripping bug (real prose in front of a
    // tag always survives; confirmed via isolated testing), just an occasional
    // generation-side lapse. Whatever the cause, a real user must never see a
    // literally blank chat bubble, so substitute a neutral filler line rather
    // than sending empty text. structured_data/options for the turn are
    // unaffected — only the visible message is patched.
    if (cleanedMessage.length === 0) {
      cleanedMessage = "Got it, let's keep going."
    }

    const maxSteps = MAX_STEPS[tool_type as ToolType]
    const stepComplete = currentStep >= maxSteps

    // Persist the structured output PROGRESSIVELY — on every turn that produced
    // data — rather than only on the final step. saveOutput is an upsert keyed
    // on (user_id, tool_type), so each write just overwrites the single row with
    // that turn's cumulative snapshot; the last/most-complete turn wins, and
    // downstream tools always read the latest.
    //
    // This deliberately no longer gates on stepComplete. Persistence used to
    // require currentStep >= maxSteps, but currentStep is derived from the
    // request's `current_step` field (a JSON number), and the frontend was not
    // sending it as a number — so currentStep silently fell back to 1,
    // stepComplete was never true, and NOTHING was ever saved (confirmed via
    // SQL: zero saved_outputs rows for completed sessions). Decoupling the save
    // from the client-supplied step makes it robust no matter whether/how the
    // frontend sends current_step. structuredData is null on turns with no
    // <data> block (or a parse failure), so a good saved report is never
    // overwritten with nothing. matcher saves under its own intake key —
    // 'matcher' itself is retired (kept only for historical rows from the old
    // 6-step flow) so lib/progress.ts's fallback completion check doesn't fire
    // off a 2-question intake instead of an actual completed matcher session.
    const saveToolType = tool_type === 'matcher' ? 'matcher_intake' : tool_type

    // The raw transcript, including THIS assistant reply, saved on EVERY turn
    // (below) — even turns with no <data> block yet — so a mid-conversation
    // refresh rehydrates the actual chat, not just the extracted report. Stored
    // flat, as a `session_history` sibling of the profile fields and `completed`
    // flag. Prefer the request's `messages` array if it sent one; otherwise
    // reconstruct from session_history + the new user message.
    const sessionHistoryToSave: unknown[] =
      Array.isArray(body.messages) && body.messages.length > 0
        ? [...(body.messages as unknown[]), { role: 'assistant', content: cleanedMessage }]
        : [
            ...(Array.isArray(body.session_history) ? (body.session_history as unknown[]) : []),
            { role: 'user', content: body.message },
            { role: 'assistant', content: cleanedMessage },
          ]

    // Persist PROGRESSIVELY on every turn (upsert keyed on user_id+tool_type).
    // Completion is an explicit flag stored IN the content — because a row now
    // exists from the first message, "a row exists" no longer means "finished",
    // so lib/progress.ts, lib/funnels.ts, and the analyze endpoints read
    // content.completed instead of row existence. audience/transformation are
    // open-ended, so completion is driven purely by hasTerminalFields; matcher
    // is a fixed 2-step intake, so its step gate still counts.
    // The REAL, hasTerminalFields-driven completion signal for this session —
    // hoisted out of the save block so it can also be returned in the response.
    // This is the authoritative "the conversation genuinely finished" flag; the
    // response's legacy step_complete is derived from the client's current_step
    // (which the frontend does not send, so it's effectively always false). The
    // frontend must key completion off THIS field, not step_complete.
    let sessionCompleted = false
    try {
      const isObj = typeof structuredData === 'object' && structuredData !== null && !Array.isArray(structuredData)
      let base: Record<string, unknown>
      if (isObj) {
        // This turn produced a data object — it's the cumulative snapshot.
        base = structuredData as Record<string, unknown>
        sessionCompleted =
          tool_type === 'matcher'
            ? stepComplete || hasTerminalFields(tool_type, base)
            : hasTerminalFields(tool_type, base)
      } else {
        // No usable data object this turn (early turns with no <data>, a parse
        // miss, or a rare non-object <data>). Persist the transcript WITHOUT
        // wiping a profile an earlier turn already saved: merge onto the prior
        // row's content and keep its completion flag; only the transcript is
        // refreshed. If there's no prior row yet, this writes a transcript-only
        // row (completed:false) so the chat survives refresh from turn one.
        const prior = await getSavedOutput(userId, saveToolType)
        const priorContent =
          prior?.content && typeof prior.content === 'object' && !Array.isArray(prior.content)
            ? (prior.content as Record<string, unknown>)
            : {}
        const { session_history: _priorHistory, completed: priorCompleted, ...priorProfile } = priorContent
        base = priorProfile
        sessionCompleted = priorCompleted === true
      }
      await saveOutput(userId, saveToolType, { ...base, completed: sessionCompleted, session_history: sessionHistoryToSave })
    } catch (saveError) {
      console.error('[tools/chat] save', saveError)
    }

    return res.status(200).json({
      message: cleanedMessage,
      options,
      structured_data: structuredData,
      // Legacy: derived from the client's current_step, which the frontend does
      // not send, so this is effectively always false. Kept for back-compat.
      step_complete: stepComplete,
      // The REAL completion signal (hasTerminalFields-driven, same value stored
      // in saved_outputs.content.completed). The frontend should trigger
      // /analyze and Part A -> Part B navigation off THIS, not step_complete.
      completed: sessionCompleted,
    })
  } catch (err) {
    console.error('[tools/chat]', err)
    return res.status(500).json({ error: 'Chat failed' })
  }
}
