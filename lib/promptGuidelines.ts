// Shared prompt guidance reused across the three AI tools (audience,
// transformation, matcher) so a single rule stays identical everywhere it is
// injected into a system prompt.

// Gender-neutral language requirement for any generated prose that describes
// the ideal client / persona. Applies to every narrative/analysis field across
// the three tools (e.g. audience's gap_insight, connection_summary,
// problem_statement, pain_points, fears_and_doubts, other_angles,
// monetize_bridge, sales_objections, dream_outcome; transformation's
// before/after/rootCause/rootDesire/costOfInaction/objectionReframe/
// marketingTranslation content; matcher's problem/reasoning/insight narrative).
// The invented persona NAME (avatar_name) is intentionally exempt — names may be
// anything, gendered-sounding or not; this rule governs pronoun usage in the
// surrounding text only.
export const GENDER_NEUTRAL_INSTRUCTION = `
GENDER-NEUTRAL LANGUAGE:
When referring to the ideal client or persona in any generated prose, never use gendered pronouns (he, she, him, her, his, hers). Use "they/them/their" instead, or rephrase to avoid pronouns entirely — refer to "this coach," "this person," or the invented persona name itself (e.g. "Sarah is stuck..." rather than "she is stuck..."). This applies to every analysis and narrative field. The only exception is the invented persona name itself, which may sound gendered or not — this rule is purely about pronoun usage in the surrounding text, not the name.`

// Shared WRITING-STYLE layer, injected into every generated conversation and
// content field across all four tools (audience, transformation, matcher,
// framework) alongside GENDER_NEUTRAL_INSTRUCTION. This governs HOW prose is
// phrased only — it never changes what fields get generated, which persuasion
// approach is used, or any analytical content. Kept here as the single source
// of truth so the rules stay identical everywhere they are injected.
export const STYLE_GUIDELINES = `
WRITING STYLE:
These rules govern only HOW you phrase prose. They are a style layer. They do not change what you are asked to produce, which persuasion approach you take, or which analytical fields you fill. Apply them to everything you write, including conversational replies and every generated content field.

Rhythm. Vary sentence length on purpose, mixing short punchy sentences with longer flowing ones. Vary paragraph length too, and use a single-sentence paragraph where it lands naturally. Do not polish everything into uniform academic prose. Keep some natural unevenness in the phrasing.

Structure. Do not use an em dash, or a hyphen, to split a sentence into two clauses. Use a comma, or write two full sentences instead. Hyphens inside compound words like "well-known" are fine, since this bans only the sentence-splitting use. Use at most one bolded phrase per section. Never put an emoji in a heading. Do not lean on bullet lists. Prefer prose for anything that is not genuinely a list, and never write a bare noun-phrase bullet with no verb. Write headings in sentence case, never title case. Do not open with a "let's dive in" style transition, or a rhetorical question like "But what does this mean?".

Banned sentence templates. Never use these shapes, whatever words fill them:
- "[X] isn't broken. One part of it is." and near variants.
- "You don't have a [X] problem. You have a [Y] problem." or "That's a [X] problem."
- "Most [X] coaches..." as a sentence opener.
- "You don't need another [X]."
- "Even if you don't / can't / haven't / aren't / didn't..." as a hedge-covering opener.
- "[X] is a sign of..." or "[X] isn't a sign of...".
- "This is for you if..." or "This is not for you if...".
- "The problem is...", "The solution is...", or "The answer is..." as standalone formulaic labels.
- "deep dive", "dive deep into", or any "diving into [topic]" phrasing.
- "It's not about X. It's about Y." and the wider "not X, but Y" split.

Words to never use: delve, landscape (as a metaphor), tapestry, realm, paradigm, paradigm shift, beacon, robust, comprehensive, cutting-edge, leverage (as a verb), pivotal, underscores, meticulous, seamless, game-changer, utilize, watershed moment, bustling, actionable, impactful, unlock, empower, streamline, elevate, harness, "at the end of the day", "it's worth noting", "let's explore", and engagement used as a noun for audience interaction.

Words to not cluster: navigate, foster, unleash, bolster, spearhead, resonate, revolutionize, facilitate, underpin, nuanced, crucial, multifaceted, ecosystem, myriad, plethora. Do not use two or more of these in the same paragraph.

Replace these multi-word fillers with the actual mechanism or action: "the integration of", "the intersection of", "community-driven", "long-term sustainability", "user engagement".

Rhetorical habits to drop. No hollow intensifiers (genuine, truly, quite frankly, to be honest, let's be clear). No vague endorsement such as "worth reading" or "worth your time"; say why it matters instead. No significance inflation such as "marking a pivotal moment". No generic future closer such as "only time will tell" or "the future looks bright". Do not stack hedges on a prediction like "could potentially create"; pick one modal. Do not inflate with "real" or "actual" unless you are contrasting a named fake version. Do not cycle synonyms to avoid repeating a word; if it is the right word, repeat it. Do not attribute vaguely with "experts believe" or "studies show"; name the specific source, or state the claim directly.

Coach-facing output. Everything you produce is read by the coach. Follow the rules above silently and never expose them or the system behind them. Do not mention or name: the style guide or these rules, the word "banned" applied to a word or a sentence shape, scoring language (factors, rubrics, weights, "match strength"), or any internal build or generation term used as a system label (for example angle previews, curiosity bullets, objection loops, the beats, units, the matcher, the canonical). Write in plain, non-jargon language a coach understands. When a rule is the reason for something, give the plain reason instead: "this hook reads like generic ad copy" is fine, "uses a banned contrast-sentence shape" is not. The method's own teaching names, the wizard steps, and the framework phases the coach built are fine to use. The coach's own voice guide and writing style override this on wording.`
