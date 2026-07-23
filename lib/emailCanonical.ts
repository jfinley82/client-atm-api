// Canonical EMAIL doctrine — the email-specific grounding layered on top of
// COPYWRITING_CANONICAL for every email the generator produces (warm-market
// invites, confirmation, watch nudges, book-a-call/conversion).
//
// This mirrors the project doc email-copywriting-canonical.md, which is the
// SOURCE OF TRUTH. The two must stay in sync — when the doc changes, update this
// string to match (and vice versa). It stacks on the other canons, it does not
// replace them: the coach's voice guide and Anti-AI style guide win on wording,
// COPYWRITING_CANONICAL governs strategy, SALES_FRAMEWORK_CANONICAL grounds the
// conversion set, and this adds email structure, subject lines, CTA mechanics,
// and deliverability. The render/design specs live in the send template and the
// wizard preview, not here.

export const EMAIL_CANONICAL = `EMAIL CANONICAL — how every email in the coach's suite is written (warm-market invites, confirmation, watch nudges, book-a-call/conversion). Layer on top of COPYWRITING_CANONICAL. The coach's voice guide and the Anti-AI style guide win on wording; COPYWRITING_CANONICAL governs strategy (honest, non-guru, second person, promise the outcome); this adds email structure and deliverability.

STRUCTURE:
- Inverted triangle: most important line first, then context, narrowing to ONE clear next step. A reader who only reads the first two lines still gets the point.
- Scannable: short paragraphs of 2-3 sentences, each separated by a blank line. Never a wall of text. Use a short "here's what's inside" list only when it earns its place.
- One email, one job, ONE call to action. No competing links. A backup link, if any, goes in a P.S., not a second button.
- A P.S. is optional and earns its keep: handle a friction point (backup link) or prime the next email ("after you watch, I'll send you X").

SUBJECT LINE:
- Short and specific, or an honest curiosity line. Enough to be worth an open, never overpromising.
- Personalize where it is real. No fake personalization.
- Keep spam triggers OUT of the subject: no "free," "guarantee," "limited time," no ALL-CAPS, no strings of ! or $. "Free" is fine in the body, not the subject.
- A question subject is fine when genuine and specific, never clickbait, and it still obeys the style guide.

HOOK + BODY:
- Open on relevance to the reader, in second person, in their world — where they are and what they want. Not a generic intro about the coach.
- Be specific: a named before-and-after or a real client result beats a vague claim and keeps it honest.
- Warm and consultative, like a real person helping. Never salesy or hyped.

CTA:
- Exactly one, action-oriented, first person, 2-5 words (e.g. "Watch the training," "Send me the training," "Book my call"). First person tends to beat second person.
- The link is a token ([TRAINING_LINK] / [REGISTER_LINK] / [BOOK_A_CALL_LINK]) — the app renders it as a styled button. Never write out a raw URL or the raw token in the body prose.

SPAM-SAFE: no all-caps blocks, no excessive punctuation, natural conversational language. Avoid canned trigger phrases ("you have been selected," "for instant access") unless genuinely natural.

PER-TYPE JOB (write to the one for this unit):
- Warm-market invite: to the coach's warm list, before opt-in. Earn the click to the opt-in page. Lead with the reader's problem, tease the training's payoff, one CTA to register ([REGISTER_LINK]).
- Confirmation: just opted in. Deliver the watch link and set the expectation to watch now. Warm thanks, what they'll get (specific), one "watch" button ([TRAINING_LINK]), a short "here's what to expect," prime the next email, a P.S. with a backup link.
- Watch nudge: opted in, hasn't watched. Get them to watch. Name that they registered and haven't watched, give ONE specific reason to watch now, one CTA ([TRAINING_LINK]).
- Book-a-call / conversion: watched. Book the implementation/next-steps call. The strongest set — name the transformation, the real cost of staying stuck, a confident clear next step ([BOOK_A_CALL_LINK]). Ground in the sales methodology. Still honest, no manufactured scarcity, no hype.

FORMAT: every body is plain text with paragraphs separated by a blank line, 2-3 sentences each.`
