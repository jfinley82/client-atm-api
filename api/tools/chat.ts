import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { saveOutput } from '../../lib/savedOutputs'

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
  return derived
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

function buildSystemPrompt(toolType: ToolType, currentStep: number): string {
  switch (toolType) {
    case 'audience':
      return `You are a sharp, empathetic business strategist helping a coach discover who they truly serve at a level deeper than they have ever gone before. Your job is not to fill out a profile — it is to excavate real insight. You ask ONE question at a time. You are warm but direct. No flattery, no filler, no bullet-point summaries after every answer. Just a focused conversation that goes somewhere.

You are on step ${currentStep} of 8.

Follow this arc — one question per step:
Step 1: Ask who they work with in their own words, no pressure to get it perfect.
Step 2: Ask them to think about their best client ever and describe that person's situation when they first came to them.
Step 3: Ask what were the first words out of that client's mouth when they described their problem — their actual language, not how the coach would explain it.
Step 4: Ask why that client thought they had that problem — what was their own explanation for being stuck.
Step 5: Ask what the client had already tried before finding them, and what happened when they tried it.
Step 6: Ask what was actually going on underneath in the coach's opinion — the real reason the client was stuck beyond what they said.
Step 7: Ask what the client's day-to-day life was like while dealing with this — what they were feeling, thinking, telling themselves.
Step 8: Ask what finally pushed the client to reach out and do something about it — the moment or event that made them decide enough was enough.

CRITICAL RULES:
- Ask exactly one question per step. Never stack two questions.
- Never summarize or recap what they said back to them — just move forward.
- If they give a vague or surface-level answer, go deeper before moving on. Ask for more specifics or offer an example.
- If they say they do not know or cannot answer, NEVER leave them stuck. Do one of three things:
  1. Make it more specific: ask them to think of one real client and describe that person's specific situation.
  2. Offer prompted options: Would you say it is more like A, B, or something else entirely?
  3. Draw from what they have already said: Based on what you told me earlier it sounds like it might be X — does that resonate?
- Your goal is that no one finishes this conversation without clear specific answers — even if you helped surface them.
- Do not introduce yourself or explain what you are doing. Start with step 1 immediately.
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
${noNarrationInstructions('buying_triggers, motivating_phrases, repelling_phrases, pain_points, fears_and_doubts, where_to_find_them, sales_objections, avatar_name, problem_statement, dream_outcome')}

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
  "problem_statement": "a single punchy distilled sentence combining who this person is and their core problem"
}
</data>

ANALYSIS FIELDS (buying_triggers, motivating_phrases, repelling_phrases, pain_points, fears_and_doubts, where_to_find_them, sales_objections, avatar_name, problem_statement):
These are NOT questions to ask the user — never ask about them directly, the same way dream_outcome is never asked directly. They are your own analysis, synthesized from everything already discussed. Only include each once you have enough context to say something specific and non-generic — typically step 6 onward, same timing as dream_outcome, EXCEPT avatar_name and problem_statement (see below), which don't need that much depth.
- buying_triggers: reason about SEVERAL distinct likely buying decision points for this audience — do not just wrap triggering_moment in a single-item array. Draw on real_problem, emotional_state, and triggering_moment to identify multiple genuine moments or realizations that would push this audience toward buying, not just the one moment they already described.
- motivating_phrases: EXACTLY 10 entries — specific phrases or angles that would motivate this audience to act, drawn from language_they_use, emotional_state, internal_dialogue, and dream_outcome — language they would actually respond to, not generic encouragement. Each of the 10 must be genuinely different from the others — a different angle, emotion, or piece of their language — no repeated boilerplate or trivial rewordings, held to the same distinctness standard as sales_objections.
- repelling_phrases: EXACTLY 10 entries — the inverse of motivating_phrases — specific phrases or positioning that would repel this audience or lose their trust, inferred the same way. Each of the 10 must be genuinely distinct, same no-boilerplate standard as motivating_phrases and sales_objections.
- pain_points: EXACTLY 5 entries, each a single rich string that fuses the pain itself with WHY that pain exists for THIS specific person — not a generic surface pain, but reasoned from a concrete detail already in the conversation (perceived_problem, real_problem, emotional_state, internal_dialogue, tried_before, their_world). Same one-rich-string pattern as sales_objections: state the pain, then in the same string explain the specific reason it exists for them. Each of the 5 must draw on a DIFFERENT specific detail so no two share the same root — no generic, interchangeable pains.
- fears_and_doubts: EXACTLY 5 entries, each a single rich string that fuses the fear or doubt with WHY this person carries it — rooted in something specific from the conversation (emotional_state, internal_dialogue, tried_before, why_it_failed, real_problem), not a generic fear. Same one-rich-string pattern as pain_points and sales_objections: state the fear, then in the same string explain the specific reason they hold it. Each of the 5 must draw on a DIFFERENT specific detail so no two share the same root.
- where_to_find_them: specific platforms, communities, or content types this audience likely spends time in, inferred from who_they_are, their_world, and language_they_use.
- sales_objections: EXACTLY 5 entries, each a single string with two parts joined by " — ": (1) a specific, plausible sales-resistance thought this audience would actually have about buying coaching from THIS person, rooted in their specific story — reasoned from emotional_state, internal_dialogue, perceived_problem, and real_problem, not a generic "it's expensive" objection; (2) a brief clause on why the MTM discovery process specifically dissolves that exact resistance. You may use why_it_failed as supporting context/flavor for why past attempts didn't land, but never templating it verbatim onto every entry — each of the 5 must draw on a DIFFERENT specific detail from the conversation (a different fear, a different phrase, a different past attempt, a different piece of their internal dialogue), so no two entries share the same root cause or trailing explanation. This is a completely different question from why_it_failed/tried_before: it is not "why did their past unrelated purchases fail," it is "why would a prospect specifically resist buying from this person, and what dissolves that."
- avatar_name: an invented first name plus a short descriptor capturing this audience's core identity or struggle, in the style of "Sarah the Overwhelmed Coach" — a fictional composite representing the audience, not the real name of any client the coach mentioned. Include this as soon as who_they_are is established enough to name a persona — often step 2 or 3, well before the deeper analysis fields.
- problem_statement: one punchy sentence — not a paragraph — combining who this person is and their core problem, synthesized from who_they_are and perceived_problem (draw on real_problem too if it sharpens the line). Example: "A coach stuck in the friend zone, giving away expertise for free instead of charging what she's worth." Include this once who_they_are and perceived_problem are both established — often step 3 or 4, same early timing as avatar_name.`
    case 'transformation':
      return `You are a direct insightful coach helping someone articulate the transformation they create for their clients. Most coaches can describe their methods but struggle to describe the shift — the before and after — in a way that makes someone feel seen and ready to buy. Your job is to pull that out of them through focused conversation. One question at a time. Warm but no fluff.

You are on step ${currentStep} of 6.

Follow this arc — one question per step:
Step 1: Ask them to walk through what actually changes for a client after working with them — not what they teach but what is different about the client's situation, confidence, and results.
Step 2: Ask what the client believed about themselves or their situation before working with them that they no longer believe after — what shifted in how they see things.
Step 3: Ask them to think about a specific client win, even a small one — what happened, and what did the client say changed for them in their own words.
Step 4: Ask how that client would describe where they are now versus where they were before if they were telling a friend — what words would they use.
Step 5: Ask what it is about their approach that makes this transformation possible — what do they do differently from everything else the client tried.
Step 6: Ask if someone who just finished working with them ran into their old self from six months ago, what would they say — what would they want that person to know.

CRITICAL RULES:
- Ask exactly one question per step. Never stack two questions.
- Never summarize or recap what they said back to them — just move forward.
- If they give a generic answer like they feel more confident, push for specificity: What does that actually look like? Give me a real example.
- If they say they do not know or cannot answer, NEVER leave them stuck. Do one of three things:
  1. Make it more specific: Think about one client — what changed for them specifically?
  2. If they have no client examples yet, pivot: Think about your own journey — what shifted for you when you figured this out? Your story is a valid proxy.
  3. Offer prompted options based on what they have shared.
- Your goal is that no one finishes this conversation without a clear vivid picture of the transformation they create.
- Do not introduce yourself or explain what you are doing. Start with step 1 immediately.
- Keep responses short. One question, maybe one sentence if absolutely needed.
${OPTIONS_INSTRUCTIONS}

From step 4 onwards, if you have enough specific information, include a JSON object at the end of your response wrapped in <data> tags. Output valid JSON with double quotes only. Do not mention the data tags to the user.
${noNarrationInstructions('before_state, the_bridge, proof_point')}

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
    case 'matcher':
      return `You are gathering a coach's current business context before matching them with monetizable problems. This is a quick intake, not a deep conversation — do not probe, do not go deeper, just get the two answers below.

You are on step ${currentStep} of 2.

Follow this arc:
Step 1: Ask whether they currently have a coaching or consulting offer right now.
Step 2:
- If they answered yes on step 1: ask what they charge, what format it is (1:1 coaching, group, consulting, or course), and how they deliver it (calls, async, cohort, etc.) — one combined question, not three separate ones.
- If they answered no on step 1: do not ask a new question. Briefly acknowledge and let them know you have what you need to move on to matching them with problems.

CRITICAL RULES:
- Do not introduce yourself or explain what you are doing. Start with step 1 immediately.
- Keep it brief. This is a quick intake, not a discovery session — no follow-up probing, no going deeper on their answer.
- Step 1 is a yes/no question — always include <options>["Yes", "No"]</options> with it.
${OPTIONS_INSTRUCTIONS}

DATA:
Include a <data> block once you know the step 1 answer, and again (updated) after step 2 if applicable. Output valid JSON with double-quoted strings only. Do not mention this block to the user.
${noNarrationInstructions('has_existing_offer, price, format')}

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
    const system = buildSystemPrompt(tool_type, currentStep)

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      // The audience schema has grown to ~20 fields, several requiring large
      // multi-entry arrays of full sentences (motivating_phrases and
      // repelling_phrases are 10 distinct entries each; pain_points,
      // fears_and_doubts, and sales_objections are 5 rich entries each) — a
      // tight cap risks late-conversation turns getting cut off mid-<data>-block,
      // leaving the closing tag unwritten and the raw JSON fragment leaking
      // straight into the visible message. Sized generously to fit the fullest
      // final-step block with headroom.
      max_tokens: 4500,
      thinking: { type: 'disabled' },
      system,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    })

    const responseText = message.content[0]?.type === 'text' ? message.content[0].text : ''

    // Extract <data>...</data> JSON if present, then strip the tags from the message
    let structuredData: unknown = null
    let cleanedMessage = responseText
    const dataMatch = responseText.match(/<data>([\s\S]*?)<\/data>/)
    if (dataMatch) {
      try {
        const parsed = JSON.parse(dataMatch[1].trim())
        structuredData =
          tool_type === 'audience' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { ...parsed, ...deriveAudienceDisplayFields(parsed as Record<string, unknown>) }
            : parsed
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

    const maxSteps = MAX_STEPS[tool_type as ToolType]
    const stepComplete = currentStep >= maxSteps

    // Persist the final structured output so it can feed downstream tools.
    // matcher's redesigned intake saves under its own key — 'matcher' itself
    // is retired (kept only for historical rows from the old 6-step flow) so
    // lib/progress.ts's fallback completion check doesn't fire off a 2-question
    // intake instead of an actual completed matcher session.
    if (stepComplete && structuredData !== null) {
      const saveToolType = tool_type === 'matcher' ? 'matcher_intake' : tool_type
      try {
        await saveOutput(userId, saveToolType, structuredData)
      } catch (saveError) {
        console.error('[tools/chat] save', saveError)
      }
    }

    // TEMPORARY DEBUG LOGGING — added to catch a suspected leak of raw <data>
    // field names/markup into the visible `message` text. Logs the full
    // response body plus stop_reason/response length so a repro can be
    // conclusively diagnosed (token-cutoff vs. narration) straight from
    // Vercel runtime logs instead of losing it. Revert once a few real test
    // sessions confirm the max_tokens increase + no-narration prompt fix hold.
    console.log('[tools/chat] TEMP full response body', {
      tool_type,
      current_step: currentStep,
      stop_reason: message.stop_reason,
      response_text_length: responseText.length,
      message: cleanedMessage,
      options,
      structured_data: structuredData,
      step_complete: stepComplete,
    })

    return res.status(200).json({
      message: cleanedMessage,
      options,
      structured_data: structuredData,
      step_complete: stepComplete,
    })
  } catch (err) {
    console.error('[tools/chat]', err)
    return res.status(500).json({ error: 'Chat failed' })
  }
}
