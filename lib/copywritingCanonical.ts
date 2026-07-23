// Canonical copywriting doctrine — the grounding for opt-in / landing copy,
// mirroring how lib/salesFrameworksCanonical.ts grounds the sales generator.
//
// This mirrors the project doc copywriting-canonical.md, which is the SOURCE OF
// TRUTH. The two must stay in sync — when the doc changes, update this string to
// match (and vice versa). It is injected verbatim into the copy-producing unit
// prompts (currently the Build wizard's angle_previews; the funnel builder's own
// landing-copy generator will ground on the same canonical later).

export const COPYWRITING_CANONICAL = `COPYWRITING CANONICAL — high-converting, non-guru opt-in copy for the coach 2-step funnel (opt-in → free micro-training video → book a call). Ground the landing headline, subheadline, curiosity bullets, and CTA in this. Same standing as the style guide: the Anti-AI style guide and the coach's voice guide win on WORDING and sentence form, this wins on STRUCTURE and strategy, and the VOICE and SECOND-PERSON layers below govern all of it.

VOICE (governs everything below): Write like a real, competent person telling the truth to another person, not a guru. Honesty over hype — promise only what is real, specific, and the coach can back; no inflated numbers, no implied guarantees, no overnight/effortless/passive framing. Never let the reader lie to themselves — where a line reads as easy or guaranteed, add the honest qualifier that keeps it true; sell the real result with the real path. No manufactured scarcity or urgency — use a limit or deadline only when it is literally true, stated plainly, with no countdown theatrics or "only 3 spots left" invention. Repel the wrong person by describing the right person's situation precisely. Real proof only — the coach's actual testimonials and numbers, or none. Plain and human — contractions, mixed sentence length, a little natural imperfection; no guru cadence, no hype adjectives, none of the "secret/hack/insane results" vocabulary. If a line would fit on a "one weird trick the gurus hate" page, recast it or cut it.

SPEAK TO ONE PERSON, AS "YOU" (second person, always): Write every line to the ONE avatar, in second person, as if talking straight to them across a table. Address them as "you" and "your." Never write ABOUT the audience in third person and never name the segment — no "coaches," "most coaches," "online coaches who…," "business owners," or any niche, group, or segment label. The reader IS the avatar. Describe their exact situation back to them in "you" language, which also qualifies: the right person thinks "that's me," the wrong person moves on. This governs the headline, subheadline, bullets, CTA, and body. It does not touch a real testimonial quote, which stays in that client's own words. Example — "You keep giving your best advice away for free, then watch them pay someone else" lands; "Most coaches give away free advice" does not.

ANGLE IS NOT HEADLINE (core rule): The ANGLE is the internal positioning concept the coach picks between (the topic's title/angle; a third-person label is fine there). The HEADLINE is the public opt-in line built FROM that angle, spoken to the reader as "you." They are different objects and must never be the same string. Never output the raw angle title as the landing_headline. Example — angle: "Your clients ask you for advice, then pay someone else." → headline: "Free training: turn the people who pick your brain for free into booked, paying clients, without chasing."

HEADLINE rules: Promise the transformation, not the training — a specific, desirable OUTCOME, not a description of the video. Be specific — concrete beats vague ("How you land a $50K raise without job-hopping" beats "how to move up"); numbers, a named before and after, and a named "without" raise specificity. Speak to the reader's pain and dream result as "you." Pass the "so what" test — push one step past the topic to what the outcome gets you. Name the "without" and keep it honest — a true difference in method (without cold outreach, without paid ads), never "without work" or "without effort."

HEADLINE structures (second person; fill with the coach's real language; each is style-guide clean):
- "How you go from [painful before] to [specific after], without [objection]."
- "The [N]-step [system or shift] that gets you [specific outcome], without [objection]."
- "Stop [the pain you name]. Start [the result you want]."
- "The real reason [the approach you already tried] keeps you [stuck state], and what gets the result instead."

SUBHEADLINE: speak to the reader as "you," clarify the promise, and tease the MECHANISM without teaching it. Pattern: "Watch this free training to [get your specific outcome], [mechanism in a few words], without [objection]." Describe their situation in "you" language rather than labeling the segment.

CURIOSITY BULLETS (exactly 3): sell the watching experience — hint at what is inside without revealing it, and only tease what the video actually delivers. Declarative, second person. No rhetorical-question openers ("Why…"), no "most [X]" opener, no "not X, it's Y" split, no em-dash splitting the line. Patterns:
- "The one shift that turns [your painful state] into [your result], and why more tactics keep you stuck."
- "The exact [structure or framework] that books your calls on autopilot, without [objection]."
- "How to position your training so the right people opt in and the wrong ones leave."

CTA: reference the training, first person, as an action — "Watch the free training" and "Yes! Send me the free training" beat "Submit"; "Save my spot" beats "Save your spot."

AVOID: the raw angle title as headline; third-person audience or segment labels ("coaches," "most coaches," any niche or group — speak to the one avatar as "you"); topic-not-outcome headlines; vague or clever-but-unclear lines; feature-not-benefit lines; the guru layer (manufactured scarcity, inflated or guaranteed promises, hype adjectives, riding the reader's wishful reading); and any banned style-guide form (rhetorical-question opener, "most [X]" opener, "not X, it's Y" split, em-dash splitting a clause) — keep the persuasion, recast the form.`
