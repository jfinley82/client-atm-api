import { stripClauseDashes, sanitizePhrasingDeep } from '../lib/phrasing'

// This module runs on the WRITE path (runUnit's sanitizePhrasingDeep(built)),
// so anything it flattens is flattened in the stored row permanently. Two rules
// reached across newlines with \s and between them turned every regenerated
// multi-paragraph body into one block — which is why three separate prompt
// hypotheses all "failed": the paragraphs were being generated correctly and
// then removed afterwards.

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}
const blanks = (s: string) => (s.match(/\n\s*\n/g) || []).length

console.log('\n-- the bug: blank lines survive --')
{
  const body = 'First paragraph, two sentences long. Here is the second.\n\nSecond paragraph starts here.\n\nThird one closes it.'
  const out = stripClauseDashes(body)
  ok('blank lines are preserved', blanks(out) === 2, JSON.stringify(out))
  ok('the paragraph text is unchanged', out === body, JSON.stringify(out))
}
{
  // The exact shape that was being destroyed: \n\n is two whitespace chars, so
  // /\s{2,}/g -> ' ' ate it.
  ok('a bare double newline is not collapsed to a space', stripClauseDashes('a\n\nb') === 'a\n\nb', JSON.stringify(stripClauseDashes('a\n\nb')))
  ok('a single newline is preserved', stripClauseDashes('a\nb') === 'a\nb')
}

console.log('\n-- the second rule: a line-leading dash is not a clause splitter --')
{
  // /\s*[—–]\s*/g -> ', ' turned this into "line, point".
  const listy = 'Here is the line.\n\n— point one\n— point two'
  const out = stripClauseDashes(listy)
  ok('the paragraph break survives a following dash', blanks(out) === 1, JSON.stringify(out))
  ok('the dash is not rewritten into a leading comma', !/\n, /.test(out) && !/^, /.test(out), JSON.stringify(out))
  ok('the list markers are left alone', out.includes('— point one'), JSON.stringify(out))
}

console.log('\n-- but the rule it exists for still fires --')
{
  ok('in-line em dash becomes a comma', stripClauseDashes('the offer — the real one — lands') === 'the offer, the real one, lands')
  ok('en dash too', stripClauseDashes('a thing – another thing') === 'a thing, another thing')
  ok('spaced hyphen splitter', stripClauseDashes('a thing - another thing') === 'a thing, another thing')
  ok('no comma stacked before end punctuation', stripClauseDashes('a thing — .') === 'a thing.', JSON.stringify(stripClauseDashes('a thing — .')))
}

console.log('-- and compounds/ranges are still untouched --')
for (const s of ['well-known', 'coffee-budget', '3-4 sessions', 'a 10-12 week program', 'e-mail']) {
  ok(`unchanged: ${s}`, stripClauseDashes(s) === s, JSON.stringify(stripClauseDashes(s)))
}

console.log('\n-- horizontal whitespace is still normalized --')
{
  ok('runs of spaces collapse', stripClauseDashes('a    b') === 'a b')
  ok('tabs collapse', stripClauseDashes('a\t\tb') === 'a b')
  ok('trailing spaces on a line go', stripClauseDashes('a   \n\nb') === 'a\n\nb', JSON.stringify(stripClauseDashes('a   \n\nb')))
  ok('leading spaces on a line go', stripClauseDashes('a\n\n   b') === 'a\n\nb', JSON.stringify(stripClauseDashes('a\n\n   b')))
  ok('a single-line field still trims like before', stripClauseDashes('  a subject line  ') === 'a subject line')
}

console.log('\n-- paragraph spacing is normalized, not destroyed --')
{
  ok('three or more newlines become one blank line', stripClauseDashes('a\n\n\n\nb') === 'a\n\nb', JSON.stringify(stripClauseDashes('a\n\n\n\nb')))
  ok('leading blank lines are dropped', stripClauseDashes('\n\na') === 'a')
  ok('trailing blank lines are dropped', stripClauseDashes('a\n\n') === 'a')
}

console.log('\n-- `original` survives the deep walk byte-for-byte --')
{
  // It is the baseline a coach edit is compared against and reset to. Sanitizing
  // it moves the baseline, so an untouched field can read as edited.
  const email = {
    email_number: 1,
    subject: 'a subject — with a dash',
    body: 'One.\n\nTwo — inline.\n\nThree.',
    original: { subject: 'a subject — with a dash', body: 'One.\n\nTwo — inline.\n\nThree.' },
  }
  const out = sanitizePhrasingDeep(email) as typeof email
  ok('the live subject is sanitized', out.subject === 'a subject, with a dash', JSON.stringify(out.subject))
  ok('the live body keeps its paragraphs', blanks(out.body) === 2, JSON.stringify(out.body))
  ok('the live body still loses the inline dash', out.body.includes('Two, inline.'), JSON.stringify(out.body))
  ok('original.subject is untouched', out.original.subject === email.original.subject, JSON.stringify(out.original.subject))
  ok('original.body is untouched', out.original.body === email.original.body, JSON.stringify(out.original.body))
}

console.log('\n-- the deep walk still reaches everything else --')
{
  const row = {
    slides: [{ slideTitle: 'a — b', talkingPoints: ['x — y'] }],
    workbook: { problem_intro: 'Para one.\n\nPara two.', sections: [{ keyInsight: 'k — v' }] },
  }
  const out = sanitizePhrasingDeep(row) as any
  ok('nested array of objects sanitized', out.slides[0].slideTitle === 'a, b')
  ok('nested string array sanitized', out.slides[0].talkingPoints[0] === 'x, y')
  ok('deeply nested object sanitized', out.workbook.sections[0].keyInsight === 'k, v')
  ok('guide body keeps its paragraphs', blanks(out.workbook.problem_intro) === 1, JSON.stringify(out.workbook.problem_intro))
  ok('non-strings pass through', sanitizePhrasingDeep({ n: 4, b: true, z: null }) as any && (sanitizePhrasingDeep({ n: 4 }) as any).n === 4)
}

console.log('\n-- a realistic regenerated body keeps every paragraph --')
{
  // Shaped like what the generator actually returns, dashes and all.
  const body = [
    'You keep answering the same question in your DMs — for free.',
    'Then they hire someone else. Not because your advice was wrong, but because nobody ever asked them to work with you.',
    'That is what this training fixes.   It takes twenty minutes.',
    'Register here: [REGISTER_LINK]',
  ].join('\n\n')
  const out = stripClauseDashes(body)
  ok('all three blank lines survive', blanks(out) === 3, `${blanks(out)}: ${JSON.stringify(out)}`)
  ok('the inline dash still became a comma', out.includes('DMs, for free.'), JSON.stringify(out))
  ok('the double space inside a paragraph collapsed', out.includes('fixes. It takes'), JSON.stringify(out))
  ok('the CTA token is intact', out.includes('[REGISTER_LINK]'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
