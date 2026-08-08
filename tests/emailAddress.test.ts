// The email validator, and the set of real addresses it must not refuse.
//
// THIS TIGHTENS A PUBLIC FORM ON THE LAUNCH PATH. A validator that rejects a
// real signup costs a lead and reports nothing — no error to a coach, no line in
// a log, just a person who tried and left. So the acceptance is not "`%@%.%` is
// refused". It is that a deliberately awkward set of REAL addresses still
// passes, each one named so a future tightening has to argue with a specific
// person rather than with a regex.
//
// Where legality is uncertain the answer is ACCEPT: a false accept is a junk row
// in a table, a false reject is a lost customer.

import { isEmailAddress, isImportableEmailAddress, normalizeEmailAddress } from '../lib/emailAddress'
import { escapeLike } from '../lib/pgFilters'
import { ilikeMatches } from './support/postgrest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

let pass = 0,
  fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++
    console.log('  PASS', label)
  } else {
    fail++
    console.log('  FAIL', label, extra ? '\n      ' + extra : '')
  }
}
function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// EACH ONE NAMED, with why it is awkward. A list of strings with a loop over it
// would report "12 passed" and tell nobody which real person is protected.
const MUST_PASS: Array<[string, string]> = [
  ['foo%bar@example.com', 'a per cent in the local part is legal atext — and a LIKE wildcard'],
  ['foo_bar@example.com', 'an underscore likewise, which is why escapeLike outlives this file'],
  ['a+b@example.com', 'plus-addressing, used by anyone who tags their signups'],
  ['a@example.com', 'a single-letter local part'],
  ['dana@my-domain.com', 'a hyphenated domain'],
  ['dana@mail.example.co.uk', 'a subdomain and a two-part public suffix'],
  ['dana@example.technology', 'a long TLD — the old rule had no length opinion and neither does this one'],
  ["o'brien@example.com", 'an apostrophe, which real surnames have'],
  ['dana.mercer@example.com', 'a dot in the local part'],
  ['DANA@EXAMPLE.COM', 'uppercase throughout — case must not decide acceptance'],
  ['dana@example.com.', 'a trailing dot is a legal fully-qualified domain'],
  ['dana@xn--p1ai.xn--p1ai', 'punycode IDN labels contain digits and hyphens'],
  ['дана@пример.рф', 'a non-ASCII address, submitted raw by some browsers'],
  ['dana@a.co', 'a two-letter TLD and a one-letter label'],
  ['dana+tag%weird_thing@sub.my-domain.co.uk', 'all of the awkward parts at once'],
]

const MUST_FAIL: Array<[string, string]> = [
  ['%@%.%', 'THE ONE THIS EXISTS FOR: a pattern matching every row, previously a legal opt-in'],
  ['%@%', 'the same without a dot'],
  ['a@%.com', 'a wildcard inside an otherwise plausible domain'],
  ['a@exam_ple.com', 'an underscore in a DOMAIN is not legal and is a single-char wildcard'],
  ['not-an-email', 'no @ at all'],
  ['a@', 'nothing after the @'],
  ['@example.com', 'nothing before it'],
  ['a b@example.com', 'whitespace'],
  ['a@example', 'no dot in the domain — the old rule refused this too'],
  ['a@.com', 'an empty first label'],
  ['a@example..com', 'an empty middle label'],
  ['a@-example.com', 'a leading hyphen in a label'],
  ['a@example-.com', 'a trailing hyphen in a label'],
  ['a@192.168.1.1', 'an unbracketed IPv4'],
  // TWO-DIGIT FINAL LABEL, on purpose. `…1.1` is refused for LENGTH (the TLD
  // rule wants 2+), so it passes whether or not the all-digits rule exists —
  // measured by mutating TLD to [\p{L}\p{N}]{2,} and watching this fixture stay
  // green. Only a final label that is long enough AND numeric can tell the two
  // rules apart.
  ['a@192.168.1.11', 'the same, with a final label long enough that only the all-digits rule can refuse it'],
  ['a@10.0.0.42', 'and again, so the rule is not passing on one arithmetic accident'],
]

;(async () => {
  console.log('\n-- awkward but REAL: every one of these must still get through --')
  for (const [address, why] of MUST_PASS) {
    ok(`accepts ${address}  (${why})`, isEmailAddress(address), 'a real signup would be silently refused')
  }

  console.log('\n-- and these must not --')
  for (const [address, why] of MUST_FAIL) {
    ok(`refuses ${address}  (${why})`, !isEmailAddress(address))
  }

  console.log('\n-- the IP-literal narrowing, recorded rather than discovered --')
  {
    // RFC 5321 says this is legal. Nobody signing up for a coaching funnel types
    // one, so refusing it is the right trade — but it IS a behaviour change, and
    // asserting it deliberately is what makes it a decision instead of a
    // side effect somebody trips over later.
    ok('user@[192.168.1.1] is refused, deliberately', !isEmailAddress('user@[192.168.1.1]'))
    ok('and so is the IPv6 form', !isEmailAddress('user@[IPv6:2001:db8::1]'))
  }

  console.log('\n-- non-strings and edges --')
  {
    for (const v of [null, undefined, 42, {}, [], true]) {
      ok(`refuses ${JSON.stringify(v) ?? 'undefined'}`, !isEmailAddress(v as unknown))
    }
    ok('trims before judging', isEmailAddress('  dana@example.com  '))
    eq('normalize lowercases and trims', normalizeEmailAddress('  DANA@Example.COM '), 'dana@example.com')
    eq('and returns null for junk', normalizeEmailAddress('%@%.%'), null)
  }

  console.log('\n-- THE VALIDATOR DOES NOT RETIRE THE ESCAPE --')
  {
    // The sentence that has to survive this commit. `foo_bar@example.com` is
    // accepted above — it must be, it is a real address — and it is a pattern
    // that matches a DIFFERENT real address. So validated input is still unsafe
    // to hand to ilike, and every escape stays.
    const patterned = 'foo_bar@example.com'
    const victim = 'fooXbar@example.com'
    ok('the patterned address is accepted', isEmailAddress(patterned))
    ok('the victim is a different, real address', isEmailAddress(victim) && victim !== patterned)
    ok('unescaped, one matches the other', ilikeMatches(patterned, victim))
    ok('escaped, it does not', !ilikeMatches(escapeLike(patterned), victim))

    // And nothing about escapeLike moved. This adds a layer; it removes nothing.
    eq('escapeLike still neutralises a per cent', escapeLike('a%b'), 'a\\%b')
    eq('and an underscore', escapeLike('a_b'), 'a\\_b')
  }

  console.log('\n-- EXACTLY ONE definition, so a seventh copy fails the gate --')
  {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, out)
        else if (full.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    // Any regex that looks like it is deciding what an email is: something
    // containing an `@` between two character classes. Deliberately broader than
    // the exact six copies that existed, so a SEVENTH written slightly
    // differently is caught too — the old ones were byte-identical, and the next
    // one will not be.
    const offenders: string[] = []
    for (const file of [...walk('api'), ...walk('lib')]) {
      if (file === 'lib/emailAddress.ts') continue
      const src = stripComments(readFileSync(file, 'utf8'))
      if (/\/[^/\n]*\[\^@[^/\n]*@[^/\n]*\//.test(src) || /\/\^[^/\n]*@[^/\n]*\\\.[^/\n]*\$\//.test(src)) offenders.push(file)
    }
    eq('no email-shaped regex outside lib/emailAddress.ts', offenders, [])

    // And the EIGHT that did exist now import the one owner. Named, because a
    // count stays right while the wrong file is the one that kept its copy.
    //
    // A CENSUS ON PURPOSE. A ninth file legitimately needing to validate an
    // address should be ADDED to this list, not cause the list to be deleted —
    // read the red as a prompt to add it, and check while you are there that it
    // imports rather than re-spelling the rule.
    //
    // Eight, not six: my first grep looked for `[^@` and missed
    // lib/coachContacts.ts and lib/memberInvite.ts, which spell the same rule
    // `[^\s@,;]`. The broader predicate above is what found them — which is the
    // argument for a predicate wider than the instances you already know about.
    for (const file of [
      'api/funnel/lead.ts',
      'api/calendar/book.ts',
      'api/email/test.ts',
      'lib/clientProgramPortal.ts',
      'lib/clientProgramEmail.ts',
      'lib/email.ts',
      'lib/coachContacts.ts',
      'lib/memberInvite.ts',
    ]) {
      ok(`${file} uses the shared validator`, /isE(mail|mportable)|isImportableEmailAddress|isEmailAddress/.test(readFileSync(file, 'utf8')), 'still carrying its own copy')
    }

    // The two importers add a DELIMITER rule on top, which is a different
    // question from address validity — a comma means the column splitter failed.
    ok('a pasted list is refused by the import rule', !isImportableEmailAddress('a@x.com,b@y.com'))
    ok('and a trailing comma too', !isImportableEmailAddress('dana@example.com,'))
    ok('but the plain address rule does not care about commas', isEmailAddress('dana@example.com'))
    ok('an ordinary address still imports', isImportableEmailAddress('dana@example.com'))
  }

  console.log('\n-- both PUBLIC entry points refuse it, not just the one we found first --')
  {
    // api/calendar/book.ts was the second public door and writes bookings.email.
    // Asserting only api/funnel/lead.ts would leave the same character class
    // reaching a second keyspace.
    for (const file of ['api/funnel/lead.ts', 'api/calendar/book.ts']) {
      const src = readFileSync(file, 'utf8')
      ok(`${file} validates with the shared function`, /if \(!isEmailAddress\(email\)\)/.test(src), 'the public door is not using it')
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
