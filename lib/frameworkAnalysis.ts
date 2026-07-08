import Anthropic from '@anthropic-ai/sdk'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { extractJson } from './aiJson'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// One of the 3 distinct naming angles for the same underlying delivery method.
// The member picks one (or writes a custom name at confirm); the framework's
// phases/steps/copy are identical regardless of which name wins.
export type FrameworkNameOption = { id: string; name: string; tagline: string; rationale: string }

export type FrameworkStep = { id: string; name: string; description: string; outcome: string }

// A phase's `color` is assigned deterministically in code (see PHASE_COLORS),
// NOT by the model — it maps to fixed Tailwind classes the frontend expects.
export type FrameworkPhase = {
  id: string
  name: string
  tagline: string
  color: string
  steps: FrameworkStep[]
}

// The stored + returned shape. The display fields (frameworkName,
// frameworkTagline, phases, descriptiveCopy, useCases, audienceLanguage) match
// the frontend FrameworkOutput interface exactly — camelCase, so no key
// mismatch. frameworkName/frameworkTagline are RESOLVED from the selected name
// option (or a custom override at confirm). name_options + selected_name_id +
// confirmed are the selection/edit state the review UI drives.
export type FrameworkAnalysis = {
  frameworkName: string
  frameworkTagline: string
  phases: FrameworkPhase[]
  descriptiveCopy: string
  useCases: string[]
  audienceLanguage: string
  name_options: FrameworkNameOption[]
  selected_name_id: string
  confirmed: boolean
}

// Fixed, deterministic phase palette — index 0 → blue, 1 → violet, 2 → emerald.
// The model never chooses colors; these strings map to Tailwind classes the
// frontend hard-codes per phase slot.
export const PHASE_COLORS = ['blue', 'violet', 'emerald'] as const

// Resolve the display name/tagline from the currently selected option. Falls
// back to the first option if the id doesn't match (e.g. stale selection).
export function resolveFrameworkName(
  options: FrameworkNameOption[],
  selectedId: string
): { frameworkName: string; frameworkTagline: string } {
  const selected = options.find((o) => o.id === selectedId) ?? options[0]
  return {
    frameworkName: selected?.name ?? '',
    frameworkTagline: selected?.tagline ?? '',
  }
}

const FRAMEWORK_PROMPT = `You are an expert brand strategist and offer designer helping a coach turn the transformation they deliver into a NAMED, proprietary results framework — the signature method they will put their name on. This is Part B of their Transform step: they have already confirmed the single transformation they build their business around, and now you are turning that transformation into a memorable, ownable delivery system a client can see themselves moving through.

You are given: (1) the coach's CONFIRMED transformation — the specific problem, outcome, before/after, root cause, and root desire they chose — and (2) their audience data — who the ideal client is and the language they use. Ground everything in this specific data. Do not produce a generic coaching framework.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "name_options": [
    { "id": "n1", "name": "a proprietary, ownable name for this method — evocative and specific, the kind a coach would trademark", "tagline": "a short punchy tagline that sits under the name", "rationale": "why this name angle fits this coach's transformation and audience" },
    { "id": "n2", "name": "...", "tagline": "...", "rationale": "..." },
    { "id": "n3", "name": "...", "tagline": "...", "rationale": "..." }
  ],
  "selected_name_id": "n1",
  "phases": [
    {
      "id": "p1",
      "name": "the name of the first phase of the journey — the starting stage the client moves through",
      "tagline": "a short line capturing what this phase is about",
      "steps": [
        { "id": "p1s1", "name": "step name", "description": "what happens in this step — concrete and specific to this method", "outcome": "the tangible shift the client has after this step" },
        { "id": "p1s2", "name": "...", "description": "...", "outcome": "..." }
      ]
    },
    { "id": "p2", "name": "...", "tagline": "...", "steps": [ ... ] },
    { "id": "p3", "name": "...", "tagline": "...", "steps": [ ... ] }
  ],
  "descriptive_copy": "a paragraph the coach could use to describe this framework — what it is, who it's for, and why it works. Written in their voice, grounded in the transformation.",
  "use_cases": ["a specific situation or moment where this framework applies", "a second distinct use case", "a third distinct use case"],
  "audience_language": "a short synthesis of how the ideal client would describe wanting this transformation — in the audience's own words, drawn from the audience data"
}

Rules:
- name_options must have EXACTLY 3 entries, ids "n1", "n2", "n3". The 3 names are genuinely distinct ANGLES on naming the SAME underlying method — a different metaphor, emphasis, or emotional hook — NOT trivial rewordings of one name. A reader should instantly feel the difference between them.
- selected_name_id is your own top pick among the 3 — the name you judge strongest for this specific coach. It must be one of "n1", "n2", "n3".
- phases must have EXACTLY 3 entries, ids "p1", "p2", "p3", in the order the client moves through them — a real progression, not 3 parallel buckets.
- Each phase must have 2 or 3 steps (no fewer than 2, no more than 3). Step ids are unique within the framework (e.g. "p1s1", "p1s2", "p2s1").
- Do NOT include a "color" field on phases — colors are assigned separately.
- The phases, steps, descriptive_copy, use_cases, and audience_language describe the SAME delivery method regardless of which name is chosen — the name is a label on the method, not a different method. Do not tailor the phases to a specific name option.
- Ground every field in the specific confirmed transformation and audience data provided. Use the client's own language where it strengthens a field. No generic coaching-industry platitudes.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

type GeneratedFramework = {
  nameOptions: FrameworkNameOption[]
  selectedNameId: string
  // Phases as generated — WITHOUT color; color is applied by the caller.
  phases: Omit<FrameworkPhase, 'color'>[]
  descriptiveCopy: string
  useCases: string[]
  audienceLanguage: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function coerceSteps(raw: unknown): FrameworkStep[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      id: asString(s.id),
      name: asString(s.name),
      description: asString(s.description),
      outcome: asString(s.outcome),
    }))
}

function coercePhases(raw: unknown): Omit<FrameworkPhase, 'color'>[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      id: asString(p.id),
      name: asString(p.name),
      tagline: asString(p.tagline),
      steps: coerceSteps(p.steps),
    }))
}

function coerceNameOptions(raw: unknown): FrameworkNameOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map((o) => ({
      id: asString(o.id),
      name: asString(o.name),
      tagline: asString(o.tagline),
      rationale: asString(o.rationale),
    }))
}

export async function generateFramework(
  transformation: unknown,
  audience: unknown,
  voiceContext?: string
): Promise<GeneratedFramework> {
  const userMessage = `CONFIRMED TRANSFORMATION: ${JSON.stringify(transformation)}

AUDIENCE DATA: ${JSON.stringify(audience)}

Generate the results framework now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 6000,
    thinking: { type: 'disabled' },
    system: voiceContext ? `${FRAMEWORK_PROMPT}\n\n${voiceContext}` : FRAMEWORK_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  // find(), not content[0] — matches the defensive pattern used across this
  // app so a future thinking-mode change doesn't silently break parsing.
  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  const parsed = extractJson(text)

  const nameOptions = coerceNameOptions(parsed.name_options)
  // selected_name_id must be one of the generated option ids; fall back to the
  // first option so the returned object always has a valid selection.
  const rawSelected = asString(parsed.selected_name_id)
  const selectedNameId = nameOptions.some((o) => o.id === rawSelected)
    ? rawSelected
    : nameOptions[0]?.id ?? ''

  return {
    nameOptions,
    selectedNameId,
    phases: coercePhases(parsed.phases),
    descriptiveCopy: asString(parsed.descriptive_copy),
    useCases: Array.isArray(parsed.use_cases) ? parsed.use_cases.filter((u: unknown) => typeof u === 'string') : [],
    audienceLanguage: asString(parsed.audience_language),
  }
}
