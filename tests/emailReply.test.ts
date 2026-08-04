import { stripQuotedReply } from '../lib/emailReply'

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}
function eq(label: string, actual: string, expected: string) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`)
}

console.log('\n-- plain replies pass through untouched --')
eq('a one-liner', stripQuotedReply('Thanks, that fixed it!'), 'Thanks, that fixed it!')
eq('the real lost reply', stripQuotedReply('thank you let me know when its done'), 'thank you let me know when its done')
eq('multi-paragraph', stripQuotedReply('First para.\n\nSecond para.'), 'First para.\n\nSecond para.')
eq('leading/trailing whitespace trimmed', stripQuotedReply('\n\n  Hello  \n\n'), 'Hello')

console.log('\n-- Gmail / Apple Mail "On ... wrote:" --')
eq(
  'classic Apple Mail form',
  stripQuotedReply("Sure, let's do Thursday.\n\nOn Aug 3, 2026, at 10:00 AM, MTM Support <noreply@mail.microtrainingmethod.com> wrote:\n> Can you do Thursday?\n>\n> Thanks,\n> MTM Support"),
  "Sure, let's do Thursday."
)
eq(
  'Gmail form with weekday',
  stripQuotedReply('Got it, thanks.\n\nOn Mon, Aug 3, 2026 at 10:00 AM MTM Support <noreply@example.com> wrote:\n> original text here'),
  'Got it, thanks.'
)
eq(
  '"wrote:" wrapped onto the next line',
  stripQuotedReply('Yes please.\n\nOn Mon, Aug 3, 2026 at 10:00 AM MTM Support <noreply@example.com>\nwrote:\n> original'),
  'Yes please.'
)

console.log('\n-- Outlook --')
eq(
  '-----Original Message-----',
  stripQuotedReply('That works for me.\n\n-----Original Message-----\nFrom: MTM Support\nSent: Monday, August 3, 2026\nHello'),
  'That works for me.'
)
eq(
  'bare From: header block',
  stripQuotedReply('Confirmed.\n\nFrom: MTM Support <noreply@example.com>\nSent: Monday, August 3, 2026 10:00 AM\nTo: Jamie\nSubject: Re: ticket'),
  'Confirmed.'
)

console.log('\n-- non-English quote headers --')
eq('French', stripQuotedReply('Merci beaucoup.\n\nLe 3 août 2026 à 10:00, MTM <x@y.com> a écrit :\n> texte'), 'Merci beaucoup.')
eq('Spanish', stripQuotedReply('Gracias.\n\nEl 3 ago 2026, a las 10:00, MTM <x@y.com> escribió:\n> texto'), 'Gracias.')
eq('German', stripQuotedReply('Danke.\n\nAm 03.08.2026 um 10:00 schrieb MTM <x@y.com>:\n> text'), 'Danke.')

console.log('\n-- signatures trimmed from the end --')
eq('RFC 3676 "-- " separator', stripQuotedReply('Sounds good.\n\n-- \nJamie\nCoach'), 'Sounds good.')
eq('Sent from my iPhone', stripQuotedReply('On my way.\n\nSent from my iPhone'), 'On my way.')
eq('Get Outlook for Android', stripQuotedReply('Okay.\n\nGet Outlook for Android'), 'Okay.')
eq(
  'signature AND quote together',
  stripQuotedReply('Will do.\n\nSent from my iPhone\n\nOn Aug 3, 2026, at 10:00 AM, MTM <x@y.com> wrote:\n> hi'),
  'Will do.'
)

console.log('\n-- ">" quoted blocks --')
eq('trailing quote block with no header', stripQuotedReply('No thanks.\n\n> previous message\n> more of it'), 'No thanks.')
eq(
  'an inline quote the member replied under is NOT deleted',
  stripQuotedReply('> Can you do Thursday?\nYes, Thursday works.'),
  '> Can you do Thursday?\nYes, Thursday works.'
)

console.log('\n-- never returns empty when there was content --')
eq('an all-quote reply is kept verbatim rather than dropped', stripQuotedReply('> only quoted text'), '> only quoted text')
eq(
  'a body that is nothing but a quote header is kept, not blanked',
  stripQuotedReply('On Aug 3, 2026, at 10:00 AM, MTM <x@y.com> wrote:'),
  'On Aug 3, 2026, at 10:00 AM, MTM <x@y.com> wrote:'
)
eq('empty input stays empty', stripQuotedReply(''), '')
eq('whitespace-only input stays empty', stripQuotedReply('   \n\n  '), '')

console.log('\n-- false positives: ordinary prose is not mistaken for a header --')
eq(
  '"From:" without an address is not a cut',
  stripQuotedReply('The error came From: the dashboard, not the API.'),
  'The error came From: the dashboard, not the API.'
)
eq(
  'a sentence starting with "On" is not a cut',
  stripQuotedReply('On Tuesday I tried again and it worked.'),
  'On Tuesday I tried again and it worked.'
)
eq(
  '"sent from" mid-sentence is not a signature',
  stripQuotedReply('I sent from my other account by mistake, can you check?'),
  'I sent from my other account by mistake, can you check?'
)

console.log('\n-- CRLF line endings (what most mail clients actually send) --')
eq(
  'CRLF normalized and stripped the same way',
  stripQuotedReply('Thanks!\r\n\r\nOn Aug 3, 2026, at 10:00 AM, MTM <x@y.com> wrote:\r\n> hi'),
  'Thanks!'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
