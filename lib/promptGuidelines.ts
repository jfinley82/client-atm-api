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
