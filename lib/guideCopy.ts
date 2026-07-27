import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'
import { GENDER_NEUTRAL_INSTRUCTION } from './promptGuidelines'
import { MtRecap, MtTransformationClose } from './microTrainingGenerator'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

type Any = Record<string, unknown>
const obj = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// The guide's close copy is a LEAD-FACING second-person rewrite. The stored
// transformation before/after states are narrated in the third person about the
// avatar ("Sarah the friend-zoned expert…"); the zoneOfImpact is the coach's
// third-person positioning. Neither can go on a lead-facing handout, and a naive
// pronoun swap mangles grammar. So we generate clean second-person copy once and
// persist it. This is the same shape whether it's a new generation or a backfill
// of an existing one.
export type GuideCopy = { transformationClose: MtTransformationClose; recap: MtRecap }

const GUIDE_COPY_PROMPT = `You write the closing copy for a lead-facing PDF workbook a coach hands to a prospect. You are given the coach's transformation analysis, which is written in the THIRD PERSON about an example client/avatar (often with a name like "Sarah"), plus the coach's positioning statement and the guide's problem framing.

Rewrite it as warm, direct copy spoken to the reader as "you". This is the emotional close of the guide.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "transformationClose": {
    "before": "2-4 sentences, SECOND PERSON — the reader's current reality, drawn from the before-state. Address them as 'you'. NEVER use the avatar's name or any he/she/they-about-the-reader. Concrete and specific, not generic.",
    "after": "2-4 sentences, SECOND PERSON — where this goes, drawn from the after-state. 'you' throughout. Same no-name rule.",
    "bridge": "ONE sentence to the reader: what closing that gap comes down to, and that it is the work you'd do together on one call. Lead-facing second person — do NOT paste the coach's positioning statement or describe 'who the coach helps'."
  },
  "recap": {
    "started": "a short paragraph, second person — where the reader was when they OPENED this guide (the frustration they walked in with). Warm, coach voice, like a personal letter.",
    "did": "a short paragraph — what they just did in the exercises (the honest self-audit). Affirming and specific.",
    "first_part": "a short paragraph — gently remind them this guide is only the FIRST part; it names the pattern and starts the shift, it does not finish it.",
    "stick": "a short paragraph, personal and encouraging — contrast how it has felt with what it could be like if they stick with it. Your genuine belief they can get there."
  }
}

Rules:
- EVERYTHING is second person, addressed to "you". Absolutely no avatar name and no third-person pronoun referring to the reader. If the source says "Sarah closes 1-2 clients a month", you write "you close 1-2 clients a month".
- Correct, natural grammar. No hype, no false scarcity.
- The recap is a personal letter from the coach; it must not repeat the problem framing verbatim and must set up the invitation.
${GENDER_NEUTRAL_INSTRUCTION}`

// Generate the guide's second-person close + recap from the (third-person)
// transformation analysis and guide framing. Never throws — returns empty strings
// on failure so the render can fall back to clean generic copy.
export async function generateGuideCopy(opts: {
  userId: string
  beforeState: string
  afterState: string
  zoneOfImpact: string
  problemIntro: string
  understanding: string
  presenterName: string
}): Promise<GuideCopy> {
  const empty: GuideCopy = {
    transformationClose: { before: '', after: '', bridge: '' },
    recap: { started: '', did: '', first_part: '', stick: '' },
  }
  try {
    const userMessage = `COACH: ${opts.presenterName}
BEFORE STATE (third person about the avatar): ${JSON.stringify(opts.beforeState)}
AFTER STATE (third person about the avatar): ${JSON.stringify(opts.afterState)}
COACH POSITIONING (zoneOfImpact, third person — for your understanding only, do not quote): ${JSON.stringify(opts.zoneOfImpact)}
GUIDE PROBLEM FRAMING (already second person): ${JSON.stringify(opts.problemIntro)}
WHERE THEY ARE (already second person): ${JSON.stringify(opts.understanding)}

Write the closing copy now.`

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      system: GUIDE_COPY_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })
    await logApiCost(opts.userId, 'guide_copy', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)

    const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    const parsed = obj(extractJson(textBlock?.text ?? ''))
    const tc = obj(parsed.transformationClose)
    const rc = obj(parsed.recap)
    return {
      transformationClose: { before: str(tc.before), after: str(tc.after), bridge: str(tc.bridge) },
      recap: { started: str(rc.started), did: str(rc.did), first_part: str(rc.first_part), stick: str(rc.stick) },
    }
  } catch (err) {
    console.error('[guideCopy] generateGuideCopy failed', err)
    return empty
  }
}

const hasClose = (tc: Any): boolean => !!(str(tc.before) && str(tc.after))
const hasRecap = (rc: Any): boolean => !!str(rc.started)

// Ensure a guide's workbook has clean second-person transformationClose + recap,
// generating and PERSISTING them when absent (backfilling existing generations on
// first render). Returns the copy to render. Best-effort: on generation failure
// the caller renders a clean generic fallback (never the avatar text).
export async function ensureGuideCopy(opts: {
  userId: string
  cardId: string
  workbook: Any
  analysis: Any
  presenterName: string
}): Promise<GuideCopy> {
  const { userId, cardId, workbook, analysis, presenterName } = opts
  const existingClose = obj(workbook.transformationClose)
  const existingRecap = obj(workbook.recap)
  const needClose = !hasClose(existingClose)
  const needRecap = !hasRecap(existingRecap)

  if (!needClose && !needRecap) {
    return {
      transformationClose: { before: str(existingClose.before), after: str(existingClose.after), bridge: str(existingClose.bridge) },
      recap: { started: str(existingRecap.started), did: str(existingRecap.did), first_part: str(existingRecap.first_part), stick: str(existingRecap.stick) },
    }
  }

  const gen = await generateGuideCopy({
    userId,
    beforeState: str(analysis.beforeState),
    afterState: str(analysis.afterState),
    zoneOfImpact: str(analysis.zoneOfImpact),
    problemIntro: str(workbook.problem_intro),
    understanding: str(workbook.understanding),
    presenterName,
  })

  // Apply only what was missing; keep any good existing copy (e.g. a new
  // generation's generator-written recap).
  const transformationClose = needClose && hasClose(gen.transformationClose as unknown as Any)
    ? gen.transformationClose
    : { before: str(existingClose.before), after: str(existingClose.after), bridge: str(existingClose.bridge) }
  const recap = needRecap && hasRecap(gen.recap as unknown as Any)
    ? gen.recap
    : { started: str(existingRecap.started), did: str(existingRecap.did), first_part: str(existingRecap.first_part), stick: str(existingRecap.stick) }

  // Persist into the stored workbook so subsequent renders skip the LLM call.
  // Best-effort — a persist failure still returns valid copy for this render.
  const generatedSomething = (needClose && hasClose(transformationClose as unknown as Any)) || (needRecap && hasRecap(recap as unknown as Any))
  if (generatedSomething) {
    try {
      const nextWorkbook = { ...workbook, transformationClose, recap }
      const { error } = await supabase
        .from('mtm_generations')
        .update({ workbook: nextWorkbook })
        .eq('user_id', userId)
        .eq('card_id', cardId)
      if (error) console.error('[guideCopy] persist failed', error)
    } catch (err) {
      console.error('[guideCopy] persist threw', err)
    }
  }

  return { transformationClose, recap }
}
