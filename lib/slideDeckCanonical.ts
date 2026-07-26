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
7. Proof — only if coach-provided proof exists; otherwise omit this beat (see PROOF below).
8. Implementation gap — honest fork: apply it alone vs apply it with guidance. No "you'll fail without us."
9. The call — the call as a bounded deliverable: named session, duration, ~3 concrete outputs, fit criteria, 1-2 honest disqualifiers, one CTA, and what happens next.
A beat may merge with a neighbor or split in two if the problem calls for it, as long as the order holds and no beat is dropped.

PROOF (conditional beat — driven ONLY by coach-provided proof):
- Include the Proof beat ONLY when the grounding contains COACH-PROVIDED PROOF. When present, build the Proof slide grounded SOLELY in that text: use only the results, numbers, names, timeframes, and outcomes the coach actually wrote, attributed exactly as they wrote them (their own result stays first person; a client's result stays that client's). Invent nothing beyond their words — no added numbers, prices, timeframes, deposits, waitlists, or embellishment.
- When NO coach-provided proof is present, OMIT the Proof beat entirely: go straight from Framework reveal to Implementation gap. Do not fabricate a result, do not substitute an anonymous client case, and do not manufacture a mechanism-only "proof" slide. The deck simply has no Proof beat.
- Proof appears on the slides ONLY if the coach supplied it. Never fabricate proof under any circumstance.

ASSERTION-EVIDENCE (per slide): the slideTitle states the CONCLUSION as a full sentence under ~15 words, not a topic label. The spoken teaching lives in the talking points the coach delivers in their own voice, never as an on-slide paragraph. Short fragment titles only on the cover and the final CTA.

HONESTY BAR: no fake scarcity, no countdowns, no manufactured urgency, no offer stacks. State a real capacity limit only if factual. Close on autonomy — they can apply it themselves or choose help. Same honesty bar as the copywriting and email canonicals.`

// Universal beat teaching, keyed by beat name (a slide's sectionName). This is
// STATIC and identical for every coach — the beat's JOB and WHY it works are the
// same regardless of topic, so it is NOT generated per training. It is the single
// source of truth the frontend renders beside each slide to teach the coach what
// the beat is for; the AI only writes the per-slide talking points and delivery
// move. Keep it in sync with the BEAT ORDER above.
export const BEAT_TEACHING: Record<string, { job: string; why: string }> = {
  Cover: {
    job: 'Re-state the outcome, who it is for, and the objection you remove, in one breath.',
    why: 'People decide in seconds whether this is about them. Naming the result and the person makes the right viewer lean in and lets the wrong one leave.',
  },
  Qualify: {
    job: 'Say who this is for, and who should not keep watching.',
    why: 'Telling the wrong person to leave is what makes the right person trust you. Fit earns more than reach.',
  },
  'Hidden bottleneck': {
    job: 'Name the real thing holding them back, the one they cannot see, and what it costs them.',
    why: 'They came for the symptom. Showing them the hidden cause is the moment they feel you understand the problem better than they do.',
  },
  'Why the old way fails': {
    job: 'Walk through why the usual approach leaves them stuck.',
    why: 'You cannot sell a new way until the old way looks broken. This clears the ground for your teaching.',
  },
  Teaching: {
    job: 'Hand them one diagnostic, shift one belief, and give one action they can take on this problem.',
    why: 'A viewer who can act differently after watching believes you can help with the rest. Teach the one problem, do not tour the whole framework.',
  },
  'Framework reveal': {
    job: 'Show your complete, named method as the bigger picture this one problem sits inside.',
    why: 'Once they have felt one piece work, seeing the whole method makes the paid path obvious without teaching all of it here.',
  },
  Proof: {
    job: 'Show one real result, in your own words, exactly as it happened.',
    why: 'One honest, specific result outweighs a wall of testimonials. Only include this beat if you have real proof to point to.',
  },
  'Implementation gap': {
    job: 'Lay out the honest fork: apply it alone, or apply it with your help.',
    why: 'Respecting that they can do it themselves is what makes the offer to help land. No "you will fail without me."',
  },
  'The call': {
    job: 'Describe the next step as a bounded session: what it is, how long, what they walk away with, and who it is for.',
    why: 'A clear, concrete next step feels safe to say yes to. A vague "book a call" does not.',
  },
}
