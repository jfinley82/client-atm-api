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
// STATIC and identical for every coach — what a beat does, why it works, and how
// it is delivered are the same regardless of topic, so it is NOT generated per
// training. It is the single source of truth the frontend renders beside each
// slide to teach the coach what the beat is for; the AI only writes the per-slide
// talking points and delivery move. Keep it in sync with the BEAT ORDER above.
export const BEAT_TEACHING: Record<string, { title: string; whatItDoes: string; whyItWorks: string; howDelivered: string }> = {
  'Cover': {
    title: 'Your opening',
    whatItDoes: 'Name the exact problem your viewer is living, in one line, so the right person leans in and everyone else clicks away.',
    whyItWorks: 'People give you their attention when you describe their situation better than they could themselves. That first line is what earns you the next fifteen minutes.',
    howDelivered: 'Usually just you, talking straight to camera, warm and direct. Skip the intro and the housekeeping and open on the problem.',
  },
  'Qualify': {
    title: 'Who this is for',
    whatItDoes: 'Show the viewer, in a few plain signs, that this training was built for their exact situation. Say who it is not for, too.',
    whyItWorks: 'When someone recognizes themselves in your list, the rest of the training feels personal instead of general. Turning the wrong people away is what makes the right people trust you.',
    howDelivered: 'Talk through the signs, or put them on screen as a short checklist. Keep it to three so it lands.',
  },
  'Hidden bottleneck': {
    title: 'The real problem',
    whatItDoes: 'Move the viewer from the symptom they can see to the hidden cause sitting underneath it.',
    whyItWorks: 'Nobody books a call to fix a problem they cannot see. Naming the real cause is what makes your offer the obvious fix later, without you having to sell it here.',
    howDelivered: 'A simple picture of the cause, drawn your own way, helps here. One idea, not five. If the line is strong enough on its own, just say it and let it sit.',
  },
  'Why the old way fails': {
    title: "Why the usual fix doesn't work",
    whatItDoes: 'Show why the thing they keep trying, more content, more effort, more free value, cannot solve this. That clears the way for the move you teach next.',
    whyItWorks: 'You earn the right to teach by being right about why they are stuck. When you name their failed fix before they say it themselves, they believe everything after it.',
    howDelivered: 'Walk the reasoning out loud, or show it as a few steps ending on the point where it breaks. Keep that ending honest and a little uncomfortable.',
  },
  'Teaching': {
    title: 'Your teaching slides',
    whatItDoes: 'Hand the viewer one thing they can use on this problem today, a way to check where they stand, a belief worth changing, or a move to make. One usable thing per slide.',
    whyItWorks: 'This is where most of the selling actually happens. When you give someone a tool that works, they trust that the fuller version works too, and they start wanting it.',
    howDelivered: 'Show the tool the way you would draw it on a whiteboard, or share your screen and walk through it. The clearer the takeaway, the more the call sells itself later.',
  },
  'Framework reveal': {
    title: 'Show your full method',
    whatItDoes: "Pull back and show today's lesson as one piece of your bigger method, so they see the whole system it came from.",
    whyItWorks: "Once they see the full method, today's win reads as a sample of something larger. That is the moment they start wanting the whole thing, not just the free piece.",
    howDelivered: 'A simple map of your method in your own words. Name the parts, but do not teach them all here. You are showing the shape, not walking through it.',
  },
  'Proof': {
    title: 'Your proof',
    whatItDoes: 'Answer the quiet question every viewer is holding, will this actually work for someone like me. You answer it with a real result, in the client\'s own words and numbers.',
    whyItWorks: 'One specific, true story from someone they recognize beats any claim you could make about yourself. If you have no real result yet, leave this slide out rather than invent one, and the training still holds.',
    howDelivered: 'Put the result on screen the way it happened, their words, their numbers, nothing added. Read it plainly and let it stand on its own.',
  },
  'Implementation gap': {
    title: 'Their two paths',
    whatItDoes: 'Lay out the two honest paths from here, doing it on their own or doing it with your help. Both are real, and you say so.',
    whyItWorks: 'When you admit they can do it alone, they trust you, and the value of your help stands on its own instead of on fear. This is the bridge that makes the call feel like a choice rather than a trap.',
    howDelivered: 'Show the two paths side by side, plainly. No "you will fail without me." Let the honest difference do the work.',
  },
  'The call': {
    title: 'The invitation',
    whatItDoes: 'Collect the decision. The teaching already did the selling, so this stays clear and bounded.',
    whyItWorks: 'By now they feel the gap themselves, so a plain next step with real outcomes beats any hard pitch. One clear ask is stronger than three.',
    howDelivered: 'You can share your booking page here. Say exactly what they will walk away with, then make the ask once and stop.',
  },
}
