import { STYLE_GUIDELINES } from '../lib/promptGuidelines'

// STYLE_GUIDELINES is injected into ~17 generator prompts, so a scope change
// here moves every tool at once. These assertions pin the SHAPE OF THE RULE,
// not the model's compliance with it — see the note at the bottom.

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const paragraphs = STYLE_GUIDELINES.split('\n\n')
const hooks = paragraphs.find((p) => p.startsWith('Hooks, titles, and subject lines.')) ?? ''
const banned = paragraphs.find((p) => p.startsWith('Banned sentence templates.')) ?? ''

// The negation rule runs across several blank-line-separated blocks (statement,
// the bulleted shapes, then the catch-all), so it is sliced by its own span
// rather than picked out as one paragraph.
const negStart = STYLE_GUIDELINES.indexOf('Clearing the ground with negations.')
const negEnd = STYLE_GUIDELINES.indexOf('Banned sentence templates.')
const negation = negStart >= 0 && negEnd > negStart ? STYLE_GUIDELINES.slice(negStart, negEnd) : ''

console.log('\n-- the negation ban is its own rule, not a clause inside the hooks rule --')
ok('a dedicated negation rule exists', negation.length > 0)
ok('it sits outside the hooks paragraph', hooks.length > 0 && !hooks.includes('Clearing the ground'))
ok('it is ordered before the literal template list', negStart >= 0 && negEnd > negStart)

console.log('\n-- and it is scoped to all prose, not just hooks/titles/subject lines --')
// The p7 regression: the rule used to live ONLY under "Hooks, titles, and
// subject lines", and a caption body is arguably none of those, so a caption
// could carry the move without breaking any stated rule.
ok('says it applies to everything', /applies to EVERYTHING you write/.test(negation))
ok('names it is not limited to hooks/titles/subject lines', /not only to hooks, titles and subject lines/i.test(negation))
for (const surface of ['body copy', 'captions', 'emails', 'conversational replies']) {
  ok(`names ${surface} as covered`, negation.includes(surface), negation.slice(0, 200))
}
ok('the hooks paragraph no longer carries the ban alone', !/negation-then-reframe/i.test(hooks), hooks)

console.log('\n-- the ban is on the maneuver, defined by what it does --')
ok('describes ruling out to make room', /rule things out to make room for the real thing/i.test(negation))
ok('says name the real thing first', /Name the real thing first/i.test(negation))
ok('bans negation used as a runway', /negation used as a runway/i.test(negation))
ok('says count does not matter', /Neither the count of negations nor the exact wording matters/i.test(negation))

console.log('\n-- it does not overcorrect into banning the word "not" --')
// Without this carve-out the rule reads as "avoid negation", which produces
// contorted prose and would ban a sentence that simply states a fact.
ok('says the word "not" itself is fine', /not the word "not"/i.test(negation))
ok('gives an informative-negation example that stays allowed', /is not included/i.test(negation))

console.log('\n-- the p7 shape specifically is now covered --')
// The literal caption that exposed the gap: a STACKED double negation with no
// "but Y" flip. It matched the family but none of the enumerated templates.
ok('stacked negations are named', /Several negations stacked before the reveal/i.test(negation))
ok('the p7 sentence appears verbatim as the example', negation.includes("It's not a confidence problem and it's not a traffic problem"))
ok('a withheld reveal is covered too', /reveal withheld/i.test(negation))
ok('a lone negation opener is covered', /lone negation opener/i.test(negation))

console.log('\n-- the literal template list is explicitly illustrative --')
// The whole point of generalizing: adding a 12th literal shape would just
// invite the 13th variant. The list must not read as an allowlist by omission.
ok('a banned-templates paragraph still exists', banned.length > 0)
ok('says the list is not complete', /not as a complete list/i.test(banned))
ok('covers wording-dodging variants', /dodges the exact wording while doing the same work/i.test(banned))
ok('says absence is not permission', /absence here is not permission/i.test(banned))

console.log('\n-- the original literal shapes survived the rewrite --')
for (const shape of [
  "It's not about X. It's about Y.",
  '"not X, but Y" split',
  "You don't have a [X] problem. You have a [Y] problem.",
  "You don't need another [X].",
  '[X] isn\'t broken. One part of it is.',
]) {
  ok(`still banned: ${shape}`, STYLE_GUIDELINES.includes(shape), 'shape dropped during the generalization')
}

console.log('\n-- unrelated rules were not disturbed --')
ok('em dash rule intact', /Do not use an em dash/.test(STYLE_GUIDELINES))
ok('word bans intact', /Words to never use: delve/.test(STYLE_GUIDELINES))
ok('coach-facing rule intact', /Coach-facing output\./.test(STYLE_GUIDELINES))

// NOTE ON WHAT THIS FILE PROVES. Every assertion above reads the INSTRUCTION
// text. Green means the rule is present, correctly scoped, and cannot be
// silently narrowed back to hooks by a later edit. It does NOT mean a generated
// caption is free of the maneuver — only reading real output does that.
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
