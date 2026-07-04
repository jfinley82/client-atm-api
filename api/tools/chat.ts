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

  const painPoints = [asString(raw.perceived_problem), asString(raw.real_problem)].filter(
    (v): v is string => v !== null
  )
  const fearsAndDoubts = [asString(raw.emotional_state), asString(raw.internal_dialogue)].filter(
    (v): v is string => v !== null
  )
  const whyItFailed = asString(raw.why_it_failed)
  const objections = asStringArray(raw.tried_before).map((item) =>
    whyItFailed ? `I already tried ${item} — ${whyItFailed}` : `I already tried ${item}`
  )
  const dreamOutcome = asString(raw.dream_outcome)

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
  "motivating_phrases": ["a specific phrase or angle likely to motivate this audience to act"],
  "repelling_phrases": ["a specific phrase or positioning likely to lose this audience's trust"],
  "where_to_find_them": ["a specific platform, community, or content type this audience likely spends time in"]
}
</data>

ANALYSIS FIELDS (buying_triggers, motivating_phrases, repelling_phrases, where_to_find_them):
These four are NOT questions to ask the user — never ask about them directly, the same way dream_outcome is never asked directly. They are your own analysis, synthesized from everything already discussed. Only include each once you have enough context to say something specific and non-generic — typically step 6 onward, same timing as dream_outcome.
- buying_triggers: reason about SEVERAL distinct likely buying decision points for this audience — do not just wrap triggering_moment in a single-item array. Draw on real_problem, emotional_state, and triggering_moment to identify multiple genuine moments or realizations that would push this audience toward buying, not just the one moment they already described.
- motivating_phrases: specific phrases or angles that would motivate this audience to act, drawn from language_they_use, emotional_state, internal_dialogue, and dream_outcome — language they would actually respond to, not generic encouragement.
- repelling_phrases: the inverse of motivating_phrases — specific phrases or positioning that would repel this audience or lose their trust, inferred the same way.
- where_to_find_them: specific platforms, communities, or content types this audience likely spends time in, inferred from who_they_are, their_world, and language_they_use.`
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
      max_tokens: 1000,
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
