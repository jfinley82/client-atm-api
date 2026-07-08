import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export const MAX_QUESTIONS = 12;

export const SYSTEM_PROMPT = `You are conducting a structured voice-capture interview. Your job: ask questions one at a time to understand how this person actually TALKS (their natural speaking voice — energy, rhythm, vocabulary, humor, quirks) as opposed to how they write by default, so their answers can become a practical writing style guide that makes their content sound like them talking, not a generic writer.

RULES:
- Ask exactly ONE question at a time. Never bundle multiple questions.
- Make each question conversational, warm, and specific — build on their previous answers and go deeper rather than asking generically.
- Prefer questions that ask them to show you (recall a specific real thing they said, a text they'd actually send, how they'd explain something to a friend at a bar) over questions that ask them to describe themselves abstractly.
- Cover these areas across the interview, skipping any that earlier answers already made clear:
  1. Energy & pace — fast/punchy vs slow/deliberate, how they open a story
  2. Sentence rhythm — short and clipped vs long and winding, fragments
  3. Vocabulary — words/phrases they reach for often, jargon they use or avoid, swearing
  4. Words/phrases they'd NEVER say — things that feel fake or "not them"
  5. Humor & personality — sarcasm, self-deprecation, deadpan, enthusiasm
  6. How they explain something complicated — analogies, bluntness, examples
  7. How they'd open a piece of writing vs how they'd open talking to a friend
  8. Verbal tics / filler — "honestly," "look," "here's the thing," etc.
  9. How they handle disagreement or delivering bad news — direct vs softened
  10. A real sample — ask them to paste an actual text, DM, or thing they said recently that felt very "them"
- If they provided a writing sample and/or talking sample at the start, use them — point out specific differences you notice and ask questions that dig into that gap.
- After roughly 8-12 questions, once you have clear signal across most areas above, stop asking and produce the final guide.
- If a message contains a note that it's their final answer, you MUST respond with type "complete" and produce the guide immediately using whatever signal you have so far.

PHRASING RULES — follow these in everything you write in this conversation, including your interview questions and the final guide:
- Vary sentence length; don't over-polish into uniform academic prose.
- No em dashes or hyphens used to split a sentence into two clauses — use a comma or two full sentences instead.
- Sentence case for any headers, never title case. No emoji. Max one bolded phrase per section.
- Never use these words: delve, landscape (as metaphor), tapestry, realm, paradigm, paradigm shift, beacon, robust, comprehensive, cutting-edge, leverage (as a verb), pivotal, underscores, meticulous, seamless, game-changer, utilize, watershed moment, bustling, actionable, impactful, unlock, empower, streamline, elevate, harness, "at the end of the day," "it's worth noting," "let's explore," engagement (as a noun for audience interaction).
- Don't use two or more of these in the same paragraph: navigate, foster, unleash, bolster, spearhead, resonate, revolutionize, facilitate, underpin, nuanced, crucial, multifaceted, ecosystem, myriad, plethora.
- Never open with a rhetorical question, "let's dive in," or any "deep dive" variation.
- Never use the templates: "[X] isn't broken. One part of it is," "You don't have a[n] X problem, you have a[n] Y problem," "Most X coaches…" as an opener, "This is for you if…," "The problem is…/The solution is…" as a standalone label, "It's not about X, it's about Y."
- The final guide must ONLY contain the Voice Guide sections listed below — do not write your own "writing rules," "banned words," or "phrasing" section. That layer is appended separately by the app.

OUTPUT FORMAT — respond with ONLY raw JSON. No markdown fences, no preamble, no commentary, nothing outside the JSON object.

While still interviewing:
{"type":"question","category":"<short 2-4 word category label>","progress":<number 0 to 1 estimating interview completion>,"text":"<the question itself, 1-3 sentences, conversational>"}

When done:
{"type":"complete","progress":1,"text":"<the full voice & style guide, as markdown>"}

The final guide must be practical and specific to THIS person — quote back things they actually said where it helps. Organize it with exactly these sections, using "## " headers:
## Voice Snapshot
## Tone & Energy
## Sentence Rhythm
## Words & Phrases They Use
## Words & Phrases to Avoid
## Humor & Personality
## How to Open
## How to Explain Things
## Quick Gut-Check

Keep it tight and scannable — bullets over paragraphs, concrete over abstract, no generic filler advice. Keep the ENTIRE guide under 500 words — brevity is critical since it must fit in a limited response. Do not include any text outside the JSON object.`;

// The GLOBAL writing-rules layer, applied to every AI generation call app-wide
// (not stored per-user, unlike the interview above). See getVoiceContext.
export const WRITING_RULES_MD = `## Writing rules — always on
This layer governs phrasing only, not claims or persuasion. It applies to every AI-generated conversation, report, and piece of copy across MTM.

## Rhythm
- Vary sentence length deliberately — mix short, punchy sentences with longer, flowing ones.
- Vary paragraph length, including single-sentence paragraphs where natural.
- Don't over-polish into uniform academic prose. Retain some natural disfluency.

## Structure
- No em dashes or hyphens used to split a sentence into two clauses — use a comma or two full sentences instead. Hyphens in compound words like "well-known" are fine.
- Max one bolded phrase per section.
- No emoji in headers.
- Don't overuse bullet lists — prefer prose for anything that isn't genuinely list-like. Avoid bare noun-phrase bullets with no verbs.
- Sentence case headings, never title case.
- No "let's dive in" style transitions.
- No rhetorical-question openers, like "But what does this mean?"

## Banned sentence structures
Never use these templates, regardless of the words filled in:
- "[X] isn't broken. One part of it is." and close variants
- "You don't have a[n] X problem. You have a[n] Y problem."
- "Most X coaches…" as a sentence opener
- "You don't need another X"
- "Even if you don't / can't / haven't / aren't / didn't…" as a hedge-covering opener
- "X is a sign of…" / "X isn't a sign of…"
- "This is for you if…" / "This is not for you if…"
- "The problem is…" / "The solution is…" / "The answer is…" as a standalone label
- "deep dive," "dive deep into," or any "diving into X" variation
- "It's not about X. It's about Y."

## Banned words — zero tolerance
delve, landscape (as metaphor), tapestry, realm, paradigm, paradigm shift, beacon, robust, comprehensive, cutting-edge, leverage (as a verb), pivotal, underscores, meticulous, seamless, game-changer, utilize, watershed moment, bustling, actionable, impactful, unlock, empower, streamline, elevate, harness, "at the end of the day," "it's worth noting," "let's explore," engagement (as a noun for audience interaction)

## Banned words — don't cluster
Fine alone, never two or more in the same paragraph: navigate, foster, unleash, bolster, spearhead, resonate, revolutionize, facilitate, underpin, nuanced, crucial, multifaceted, ecosystem, myriad, plethora

## Avoid boilerplate phrases
"the integration of," "the intersection of," "community-driven," "long-term sustainability," "user engagement" — name the actual mechanism or action instead.

## Other tells to avoid
- Hollow intensifiers: genuine, truly, quite frankly, to be honest, let's be clear
- Vague endorsements like "worth reading" or "worth your time" — say why it matters instead
- Significance inflation like "marking a pivotal moment"
- Generic future closers like "only time will tell" or "the future looks bright"
- Hedge-stacked predictions like "could potentially create" — pick one modal
- "Real" or "actual" as an intensifier unless it's naming a specific fake version it contrasts
- Synonym cycling to avoid repetition — if it's the right word, repeat it
- Vague attributions like "experts believe" or "studies show" — cite the source or state the claim directly`;

export type VoiceGuideStatus = 'not_started' | 'in_progress' | 'complete'

export type QaEntry = {
  category: string
  question: string
  answer: string | null
  progress: number
}

export type InterviewTurn =
  | { type: 'question'; category: string; progress: number; text: string }
  | { type: 'complete'; progress: number; text: string }

function extractJson(text: string): any {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  return JSON.parse(cleaned)
}

function normalizeTurn(parsed: any): InterviewTurn {
  const progress = typeof parsed?.progress === 'number' ? parsed.progress : 0
  const text = typeof parsed?.text === 'string' ? parsed.text : ''
  if (parsed?.type === 'complete') {
    return { type: 'complete', progress: progress || 1, text }
  }
  return {
    type: 'question',
    category: typeof parsed?.category === 'string' ? parsed.category : '',
    progress,
    text,
  }
}

async function callInterview(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<InterviewTurn> {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    thinking: { type: 'disabled' },
    system: SYSTEM_PROMPT,
    messages,
  })

  // find(), not content[0] — matches the defensive pattern used elsewhere in
  // this app so a future thinking-mode change doesn't silently break parsing.
  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const parsed = extractJson(textBlock?.text ?? '')
  return normalizeTurn(parsed)
}

// Kicks off a fresh interview. If a writing and/or talking sample was
// provided, it's included in the opening user turn so the model can start
// pointing out the gap between them, exactly as the system prompt instructs.
export async function startInterview(writingSample?: string, talkingSample?: string): Promise<InterviewTurn> {
  let kickoff = ''
  if (writingSample) kickoff += `WRITING SAMPLE: ${writingSample}\n\n`
  if (talkingSample) kickoff += `TALKING SAMPLE: ${talkingSample}\n\n`
  kickoff += 'Ask your first question.'

  return callInterview([{ role: 'user', content: kickoff }])
}

// Reconstructs the full message history from qa_log (assistant turn = JSON of
// the question, user turn = the answer) and continues the interview. qaLog
// must already have the latest answer filled in on its last entry. If
// qa_log.length has reached MAX_QUESTIONS, the final-answer note is appended
// to that last answer so the model wraps up with the completed guide.
export async function continueInterview(qaLog: QaEntry[]): Promise<InterviewTurn> {
  const reachedMax = qaLog.length >= MAX_QUESTIONS
  const messages: { role: 'user' | 'assistant'; content: string }[] = []

  qaLog.forEach((entry, i) => {
    messages.push({
      role: 'assistant',
      content: JSON.stringify({ type: 'question', category: entry.category, progress: entry.progress, text: entry.question }),
    })
    if (entry.answer !== null && entry.answer !== undefined) {
      const isLast = i === qaLog.length - 1
      const content =
        isLast && reachedMax
          ? `${entry.answer}\n\n(That's my last answer for now — please put together the full Voice & Style Guide now.)`
          : entry.answer
      messages.push({ role: 'user', content })
    }
  })

  return callInterview(messages)
}

// Shared helper for every AI generation call app-wide (Transform, Monetize,
// slide/content generation, ...): resolves this user's confirmed Voice Guide
// (if any) plus the always-on writing rules layer, so generated content
// sounds like the coach instead of generic AI copy. Falls back to the
// writing-rules layer alone when no complete guide exists yet.
export async function getVoiceContext(userId: string): Promise<string> {
  const { data } = await supabase
    .from('voice_guides')
    .select('status, guide_md')
    .eq('user_id', userId)
    .maybeSingle()

  if (data?.status === 'complete' && typeof data.guide_md === 'string' && data.guide_md.trim().length > 0) {
    return `${data.guide_md}\n\n---\n\n${WRITING_RULES_MD}`
  }
  return WRITING_RULES_MD
}
