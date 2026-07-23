// Canonical house sales methodology — the grounding for the call-script and
// objection generators, mirroring how lib/slidesCanonical.ts grounds the slide
// generator. It encodes the 6-Step High Ticket Selling Framework and the four
// Objection Loops as house doctrine so generated scripts stay on-method.
//
// AUTHORING NOTE: this was drafted from the framework's beat + loop names and the
// MTM house style (consultative, transformation-first, A→B, never a hard pitch).
// It is the single place to refine the methodology wording — replace the text
// below with the authoritative claude/sales-frameworks-canonical.md content when
// available and both generators pick it up with no code change.

// The six beats, in order. The generator MUST produce exactly these six, in this
// sequence, using the coach's own offer/audience language.
export const SALES_SCRIPT_BEATS = [
  'Confirm Intentions',
  'Measure the Gap',
  'Expose Opportunities',
  'Build the Bridge',
  'Sell A→B',
  'Invite/Ask',
] as const

// The four objection loops. Every captured objection maps to exactly one.
export const OBJECTION_LOOPS = ['commitment', 'fear_of_failure', 'self_doubt', 'bad_timing'] as const
export type ObjectionLoop = (typeof OBJECTION_LOOPS)[number]

// Injected verbatim into the sales-script + objection unit prompts.
export const SALES_FRAMEWORK_CANONICAL = `HOUSE SALES METHODOLOGY (ground the script and objections in this — it is the method, not a suggestion):

THE 6-STEP HIGH TICKET SELLING FRAMEWORK — a consultative, transformation-first call. It is never a hard pitch; it helps the prospect see the gap between where they are and where they want to be, and decide for themselves. Produce the six beats IN THIS ORDER:

1. Confirm Intentions — open by confirming why they took the call and what they hope to walk away with. Prospect mindset: guarded, wondering if this is worth their time. The coach's line sets a collaborative frame and gets a clear yes on the goal.
2. Measure the Gap — get specific about where they are now versus where they want to be. Prospect mindset: starting to name the real problem out loud. The coach's line draws out the current state and the desired state so the distance is concrete and felt.
3. Expose Opportunities — surface what's actually possible for them and what's been in the way. Prospect mindset: realizing the problem is solvable and they've been stuck on the wrong thing. The coach's line reframes the obstacle using the coach's framework and points at the leverage they've been missing.
4. Build the Bridge — connect the gap to a clear path across it, grounded in the coach's framework and transformation. Prospect mindset: seeing a credible route from A to B for the first time. The coach's line lays out the path in the coach's own method language, so the offer becomes the obvious vehicle.
5. Sell A→B — present the offer as the vehicle from their current state (A) to their desired state (B), in terms of the outcome, not features. Prospect mindset: weighing whether this is the right vehicle for them. The coach's line names the offer and ties it directly to the B they just described.
6. Invite/Ask — invite them to take the next step with a clear, low-pressure ask. Prospect mindset: ready to decide, wanting permission and clarity. The coach's line makes the ask directly and warmly, then gets out of the way.

For each beat return: a one-line PROSPECT MINDSET for that moment (their internal state), and 2-3 PHRASING OPTIONS the coach could actually say — in the coach's real offer and audience language — plus a recommended DEFAULT (the strongest of the options, or a blend). Phrasings are things the coach says out loud on the call: warm, plain, specific to this offer and audience. No scripts that sound canned or manipulative.

THE OBJECTION LOOPS — every real objection is one of four underlying loops. Handle by naming the true concern with empathy, reframing through the transformation, and returning the decision to the prospect. Never argue or pressure.

- commitment — price / money / "is it worth it": the objection is really about certainty of return. Handle by anchoring cost against the cost of staying at A and the value of reaching B.
- fear_of_failure — "what if it doesn't work for me": fear of investing and not getting the result. Handle by de-risking with the framework, proof, and the specific reason it will work for their situation.
- self_doubt — "I'm not sure I can do this / I'm different": doubt in themselves, not the offer. Handle by reframing their capability and showing the path is built for people exactly like them.
- bad_timing — "not right now / later": avoidance dressed as timing. Handle by surfacing the real cost of waiting and the compounding gap, gently.

For each captured audience objection: phrase the OBJECTION in the PROSPECT'S OWN WORDS (how they'd actually say it), give the HANDLING grounded in this coach's offer and transformation, and map it to exactly one LOOP from: commitment | fear_of_failure | self_doubt | bad_timing.`
