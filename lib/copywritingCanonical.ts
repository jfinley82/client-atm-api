// Canonical copywriting doctrine — the grounding for opt-in / landing copy,
// mirroring how lib/salesFrameworksCanonical.ts grounds the sales generator.
//
// This mirrors the project doc copywriting-canonical.md, which is the SOURCE OF
// TRUTH. The two must stay in sync — when the doc changes, update this string to
// match (and vice versa). It is injected verbatim into the copy-producing unit
// prompts (currently the Build wizard's angle_previews; the funnel builder's own
// landing-copy generator will ground on the same canonical later).

export const COPYWRITING_CANONICAL = `COPYWRITING CANONICAL — high-converting, non-guru opt-in copy for the coach 2-step funnel (opt-in → free micro-training video → book a call). Ground the landing headline, subheadline, curiosity bullets, and CTA in this. Same standing as the style guide: the Anti-AI style guide and the coach's voice guide win on WORDING and sentence form, this wins on STRUCTURE and strategy, and the VOICE layer below governs all of it.

VOICE (governs everything below): Write like a real, competent person telling the truth to another person, not a guru. Honesty over hype — promise only what is real, specific, and the coach can back; no inflated numbers, no implied guarantees, no overnight/effortless/passive framing. Never let the reader lie to themselves — where a line reads as easy or guaranteed, add the honest qualifier that keeps it true; sell the real result with the real path. No manufactured scarcity or urgency — use a limit or deadline only when it is literally true, stated plainly, with no countdown theatrics or "only 3 spots left" invention. Repel the wrong person as much as you attract the right one. Real proof only — the coach's actual testimonials and numbers, or none. Plain and human — contractions, mixed sentence length, a little natural imperfection; no guru cadence, no hype adjectives, none of the "secret/hack/insane results" vocabulary. If a line would fit on a "one weird trick the gurus hate" page, recast it or cut it.

ANGLE IS NOT HEADLINE (core rule): The ANGLE is the internal positioning concept the coach picks between (the topic's title/angle). The HEADLINE is the public opt-in line built FROM that angle. They are different objects and must never be the same string. Never output the raw angle title as the landing_headline. Example — angle: "Your clients ask you for advice, then pay someone else." → headline: "Free training: how coaches turn the people who pick their brain for free into booked, paying calls, without chasing."

HEADLINE rules: Promise the transformation, not the training — a specific, desirable OUTCOME, not a description of the video. Be specific — concrete beats vague ("how I help burned-out executives land a $50K raise without job-hopping" beats "how to advance your career"); numbers, a named before and after, and a named "without" raise specificity. Frame around the ideal client's pain and dream result. Pass the "so what" test — push one step past the topic to what the outcome gets them. Name the "without" and keep it honest — a true difference in method (without cold outreach, without paid ads), never "without work" or "without effort."

HEADLINE structures (fill with the coach's real language; each is style-guide clean):
- "How [who] go from [painful before] to [specific after], without [objection]."
- "The [N]-step [system or shift] that [specific outcome], without [objection]."
- "Stop [the pain they name]. Start [the result they want]."
- "The real reason [common approach they tried] keeps you [stuck state], and what gets the result instead."

SUBHEADLINE: name WHO it is for, clarify the promise, and tease the MECHANISM without teaching it. Pattern: "Watch this free training to [specific outcome], [mechanism in a few words], without [objection]." Name the audience explicitly.

CURIOSITY BULLETS (exactly 3): sell the watching experience — hint at what is inside without revealing it, and only tease what the video actually delivers. Declarative. No rhetorical-question openers ("Why…"), no "most [X]" opener, no "not X, it's Y" split, no em-dash splitting the line. Patterns:
- "The one shift that turns [painful state] into [result], and why more tactics keep [audience] stuck."
- "The exact [structure or framework] that books calls on autopilot, without [objection]."
- "How to position the training so the right [audience] opt in and the wrong ones leave."

CTA: reference the training, first person, as an action — "Watch the free training" and "Yes! Send me the free training" beat "Submit"; "Save my spot" beats "Save your spot."

AVOID: the raw angle title as headline; topic-not-outcome headlines; vague or clever-but-unclear lines; feature-not-benefit lines; the guru layer (manufactured scarcity, inflated or guaranteed promises, hype adjectives, riding the reader's wishful reading); and any banned style-guide form (rhetorical-question opener, "most [X]" opener, "not X, it's Y" split, em-dash splitting a clause) — keep the persuasion, recast the form.`
