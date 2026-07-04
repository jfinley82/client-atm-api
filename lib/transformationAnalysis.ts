import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export type TransformationCandidate = {
  id: string
  problem: string
  outcome: string
  whySelected: string
  beforeState: { beliefs: string; internalTalk: string; results: string }
  afterState: { beliefs: string; internalTalk: string; results: string }
  rootCause: { corePattern: string; sustainingBelief: string; emotionalProtection: string; skillVsIdentity: string }
  rootDesire: { surfaceDesire: string; emotionalDesire: string; identityShift: string; lifestyleShift: string }
  costOfInaction: { inaction: string; action: string }
  objectionReframe: { objection: string; reframe: string }
  marketingTranslation: { stopSaying: string; startSaying: string }
}

export type TransformationAnalysis = {
  zoneOfImpact: string
  intersection: string[]
  uniquelyEquipped: string[]
  candidates: TransformationCandidate[]
  selected_id: string | null
  confirmed: boolean
}

function extractJson(text: string): any {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  return JSON.parse(cleaned)
}

const TRANSFORMATION_ANALYSIS_PROMPT = `You are an expert brand strategist and messaging psychologist helping a coach identify the transformation they should build their entire business identity around. This is the single most important output in their process — they will personally stand behind whichever candidate they choose as the foundation of their positioning, offers, and marketing. Reason carefully and specifically; do not produce generic coaching language.

You are given the coach's full transformation conversation data: before state, after state, the bridge, proof point, and the exact language the client used before and after.

Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.

{
  "zoneOfImpact": "a specific articulation of this coach's overarching business positioning — grounded in their actual transformation data, not generic. Computed once, independent of which candidate is later chosen.",
  "intersection": ["a specific point where this coach's unique approach, their ideal client's felt need, and a real market opportunity all overlap", "a second distinct intersection point", "a third distinct intersection point"],
  "uniquelyEquipped": ["a specific reason this coach specifically (not coaches in general) is positioned to deliver this transformation", "a second distinct reason", "a third distinct reason"],
  "candidates": [
    {
      "id": "t1",
      "problem": "a specific articulation of the problem this framing centers on",
      "outcome": "a specific articulation of the outcome this framing centers on",
      "whySelected": "why this specific framing is a strong candidate for this coach's business identity",
      "beforeState": { "beliefs": "...", "internalTalk": "...", "results": "..." },
      "afterState": { "beliefs": "...", "internalTalk": "...", "results": "..." },
      "rootCause": { "corePattern": "...", "sustainingBelief": "...", "emotionalProtection": "...", "skillVsIdentity": "..." },
      "rootDesire": { "surfaceDesire": "...", "emotionalDesire": "...", "identityShift": "...", "lifestyleShift": "..." },
      "costOfInaction": { "inaction": "...", "action": "..." },
      "objectionReframe": { "objection": "...", "reframe": "..." },
      "marketingTranslation": { "stopSaying": "...", "startSaying": "..." }
    }
  ],
  "selected_id": null
}

Rules:
- candidates must have EXACTLY 3 entries, ids "t1", "t2", "t3".
- The 3 candidates must be genuinely distinct articulations of the SAME core transformation this coach delivers — different angle, different emphasis, different emotional entry point — NOT 3 different problems, and NOT 3 trivial rewordings of the same sentence. A reader should be able to tell instantly which one they would rather build a business around.
- Ground every field in the specific conversation data provided. Use the client's own language where it strengthens a field. Do not write generic coaching-industry platitudes.
- rootCause and rootDesire should go beneath what the client said explicitly — this is your expert psychological read of what is really driving the before/after shift, not a restatement of the surface answers.
- marketingTranslation should give a concrete before/after phrase pair the coach could literally use in copy — not abstract advice about messaging.
- selected_id is always null in this output — it is set later by the member.
- Reason as thoroughly as this decision deserves — it is the foundation the coach's whole business identity will be built on.`

export async function generateTransformationAnalysis(
  transformation: unknown
): Promise<{ zoneOfImpact: string; intersection: string[]; uniquelyEquipped: string[]; candidates: TransformationCandidate[] }> {
  const userMessage = `TRANSFORMATION DATA: ${JSON.stringify(transformation)}
Generate the transformation analysis now.`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 6000,
    thinking: { type: 'disabled' },
    system: TRANSFORMATION_ANALYSIS_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  // find(), not content[0] — matches the defensive pattern used elsewhere in
  // this app even though thinking is disabled here, so a future thinking
  // mode change doesn't silently break this again.
  const textBlock = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  const text = textBlock?.text ?? ''
  const parsed = extractJson(text)

  return {
    zoneOfImpact: typeof parsed.zoneOfImpact === 'string' ? parsed.zoneOfImpact : '',
    intersection: Array.isArray(parsed.intersection) ? parsed.intersection : [],
    uniquelyEquipped: Array.isArray(parsed.uniquelyEquipped) ? parsed.uniquelyEquipped : [],
    candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
  }
}
