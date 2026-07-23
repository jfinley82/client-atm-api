// Canonical house sales methodology — the grounding for the call-script and
// objection generators, mirroring how lib/slidesCanonical.ts grounds the slide
// generator. It encodes Jamaul's taught implementation-call method (the six
// beats) and the four Objection Loops as house doctrine so generated scripts
// stay on-method.
//
// This is mandatory grounding with the same standing as the Anti-AI style guide;
// the coach's own voice guide still wins on wording conflicts. It is the single
// place to refine the methodology wording — both generators pick up any change
// here with no code change.

// The six beats, in order. The generator MUST produce exactly these six, in this
// sequence, using the coach's own offer/audience language.
export const SALES_SCRIPT_BEATS = [
  'Confirm intentions',
  'Measure the gap',
  'Help and expand',
  'Bridge to agreement',
  'Without a shadow of doubt',
  'The logical next step',
] as const

// The four objection loops. Every captured objection maps to exactly one. They
// are the proactive handling toolkit used in beat 5 — not a close-the-no mechanic.
export const OBJECTION_LOOPS = ['commitment', 'fear_of_failure', 'self_doubt', 'bad_timing'] as const
export type ObjectionLoop = (typeof OBJECTION_LOOPS)[number]

// Injected verbatim into the sales-script + objection unit prompts.
export const SALES_FRAMEWORK_CANONICAL = `HOUSE SALES METHODOLOGY — Jamaul's taught implementation-call method. Ground the script and objections in this. It is the method, not a suggestion, and carries the same standing as the style guide.

WHAT THIS CALL IS: an implementation / next-steps call, NOT a cold pitch. The prospect already watched the micro-training and started applying it. The coach shows up to HELP: review what happened when they acted, add clarity, hand them something concrete, and offer the logical next step. Spirit: lead, don't beg; selling is sharing. The call COLLECTS A YES — it does not chase a no. Never a hard pitch, no pressure, no false scarcity.

THE SIX BEATS, IN ORDER:

1. Confirm intentions — state why you're both on the call and gain agreement on it. Sets the tone. Prospect mindset: checking whether this is worth their time and what it's really about.
2. Measure the gap — open-ended questions about where they are now, their pains and challenges. Notice whether they speak in NUMBERS or in VISION, and match that later. Prospect mindset: naming out loud where they actually are and what's hard.
3. Help and expand — the VALUE MOMENT. Show up ready to give: review their results from acting on the video, help them refine, clear up where they're stuck, and hand them something concrete. This is NOT "expose pain to set up a sell" — it is genuine help. Prospect mindset: feeling helped, seeing progress and what's next.
4. Bridge to agreement — get on the same page BEFORE any offer talk. Make sure you both see their situation the same way. Clarity before is what turns a conversation into a closing. Prospect mindset: agreeing on where they are and where they want to be.
5. Without a shadow of doubt — proactively handle the objections they haven't raised yet, show more results and proof, and gain their agreement to look at something. The objection work happens HERE, on the front foot, not as damage control at the end. This is where the four Objection Loops get used. Prospect mindset: quiet doubts surfacing and being answered before they harden.
6. The logical next step — lay out the logical next step and collect the yes. This is NOT an emotional invite that stings on a no. Some will, some won't, and that's fine. Present the next step cleanly and let them choose. Prospect mindset: ready to decide, wanting a clear, pressure-free next step.

For each beat return: a one-line PROSPECT MINDSET for that moment (their internal state), and 2-3 PHRASING OPTIONS the coach could actually say — in the coach's real offer and audience language — plus a recommended DEFAULT (the strongest option, or a blend). Phrasings are things the coach says out loud on the call: warm, plain, share-not-sell, specific to this offer and audience. Never canned or manipulative.

BUYER TYPES (optional tone layer, DISC-style reference — do not force, use only where it sharpens a phrasing):
- Analytical: data-focused. Answer questions, be patient, stay literal, consider a 2-step close.
- Amiable: empathy and trust. Build rapport, lead as a trusted advisor, share the story and others' results.
- Assertive: decisive, results-focused. Professionalism, get to the crux fast, competitive advantage.
- Expressive: relationship and intuition. Extend the relationship, emphasize impact on others, streamline the facts.

THE OBJECTION LOOPS — the handling toolkit, used PROACTIVELY in beat 5. Premise: an objection is an invitation to investigate further, a SOFT YES waiting to be validated, not a hard no. Surface and handle them before they harden. Do NOT build a "loop back to convert the no" mechanic at the close — beat 6 stays a clean offer of the next step.

- commitment — price / cost. Usually the REAL issue; it does not mean the price is too high and you do not lower it. Handle by: compare the cost of the program to the cost of NOT acting; reconfirm any guarantee; lower the initial investment or start when paid in full.
- fear_of_failure — theirs and yours. Past failures make them doubt THEMSELVES, not you. Handle by: reconfirm their desired result and the promise; clarify the transition from A to B; clarify the milestones and how they'll recognize progress.
- self_doubt — they're ready but the gap feels too big to cross in the time given. Handle by: chunk it into smaller steps; show examples of people like them who made it; explain your support and community as a safe place to fail.
- bad_timing — they haven't made the problem a real pain point. Handle by: get them to name the time they've already spent trying to fix this; relate time to money and total up what they've already spent of both.

For each captured audience objection: phrase the OBJECTION in the PROSPECT'S OWN WORDS (how they'd actually say it), give the HANDLING grounded in this coach's offer and transformation using the matching loop's tactics above (proactive, warm, share-not-sell — an invitation to look closer, never a pressure play), and map it to exactly one LOOP from: commitment | fear_of_failure | self_doubt | bad_timing.`
