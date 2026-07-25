// Canonical slide-deck doctrine — the grounding for the micro-training slide
// unit, mirroring how lib/salesFrameworksCanonical.ts / lib/copywritingCanonical.ts
// / lib/emailCanonical.ts ground their generators.
//
// This mirrors the project doc slides-canonical.md, which is the SOURCE OF TRUTH.
// The two must stay in sync — when the doc changes, update this string to match
// (and vice versa). It is injected verbatim into the `slides` unit prompt only.

export const SLIDES_CANONICAL = `SLIDE DECK DOCTRINE (micro-training)

WHAT THIS IS: a recorded 15-20 minute solo teaching video (target ~17 min). It preserves the psychological ORDER of a sales presentation while compressing the material to ONE urgent problem, ONE differentiated mechanism, ONE relevant proof, ONE clear next step. Its job is not to close the paid engagement — it is to make a diagnostic call feel useful, relevant, and safe. It is NOT a webinar and NOT a live session.

NO FIXED SLIDE COUNT: the deck is exactly as long as the ONE problem needs — no padding to a target, no compressing a problem that needs teaching. What is fixed is the ORDER of the beats below. How many slides each beat takes flexes to the problem; the teaching section in particular expands or contracts to whatever actually teaches THIS problem. Judge length by the beats, not a number, and keep the whole thing inside the 15-20 minute window (usually 8-14 slides).

TEACH THE ONE PROBLEM — DO NOT TOUR THE FRAMEWORK: the teaching section teaches the specific problem this deck is built around. It hands the viewer a usable diagnostic, shifts one belief, and gives one action they can take on this problem. Draw only on the parts of the coach's framework that move the viewer on THIS problem. Do not organize the teaching as "step 1, step 2, step 3" of the framework, and do not display the whole framework in the teaching. Every teaching slide must TEACH, not showcase: the viewer must be able to act on their own problem differently after it.

THE COACH OWNS THE PROCESS: the coach's framework is theirs and is bigger than this one training. Reveal the complete, named framework in the Framework reveal beat, AFTER the teaching, as the larger method this problem sits inside. Include this beat whenever the coach has a framework — it is where their full process is shown as theirs. It is consolidation and context, not new teaching.

BEAT ORDER (sectionName = the beat name, exactly as below):
1. Cover — re-establish the outcome + audience + "without [objection]", one-line subtitle, short presenter line. No greeting, housekeeping, or bio.
2. Qualify — "this is for you if..." with 3 fit lines; say who should NOT continue too.
3. Hidden bottleneck — symptom -> hidden bottleneck -> cost. One sentence that becomes the organizing idea.
4. Why the old way fails — the causal chain of why the old approach leaves them stuck; bridge to the teaching.
5. Teaching — as many slides as it takes (commonly 2-3): a diagnostic they can run, the belief that must shift, the action to take. Assertion-evidence each.
6. Framework reveal — the coach's complete named framework as the bigger method (include whenever a framework is present).
7. Proof — see PROOF LADDER below.
8. Implementation gap — honest fork: apply it alone vs apply it with guidance. No "you'll fail without us."
9. The call — the call as a bounded deliverable: named session, duration, ~3 concrete outputs, fit criteria, 1-2 honest disqualifiers, one CTA, and what happens next.
A beat may merge with a neighbor or split in two if the problem calls for it, as long as the order holds and no beat is dropped.

PROOF LADDER (this beat NEVER fabricates). Two hard rules govern it:
- GROUNDING-ONLY: use ONLY results, numbers, prices, timeframes, and outcomes that are actually stated in the provided grounding. Never introduce a figure or outcome the grounding does not state, and never embellish a modest result into a bigger one — no added dollar amounts, percentages, price increases, deposits, waitlists, or timeframes that are not in the grounding.
- ATTRIBUTE HONESTLY: present the result as whoever actually achieved it in the grounding. If the grounding describes the COACH'S OWN result, present it as theirs in first person ("my own calls went from..."), never as an anonymous third party ("a coach... she..."). Only present it as a client case if the grounding actually describes a client's result.
Use the HIGHEST real rung available:
1. A real client result stated in the grounding (baseline -> part of the method applied -> result -> timeframe -> source).
2. The coach's OWN result stated in the grounding — presented as theirs, in first person. Founder proof is legitimate.
3. Mechanism proof — walk the first-principles reason this necessarily works, so the viewer reaches "of course that works" on their own.
4. Demonstration — teach the one thing well enough that the viewer gets a small real win inside the video itself.
If the grounding contains NO result, do not invent one: the Proof beat becomes mechanism and/or demonstration, and the call stays honest about where the coach is (e.g. working with a small first group) rather than implying a track record. When in doubt, drop a rung rather than reach for a number that isn't there.

ASSERTION-EVIDENCE (per slide): the slideTitle states the CONCLUSION as a full sentence under ~15 words, not a topic label. The spoken teaching lives in the script/speaker note, never as an on-slide paragraph. Short fragment titles only on the cover and the final CTA.

HONESTY BAR: no fake scarcity, no countdowns, no manufactured urgency, no offer stacks. State a real capacity limit only if factual. Close on autonomy — they can apply it themselves or choose help. Same honesty bar as the copywriting and email canonicals.`
