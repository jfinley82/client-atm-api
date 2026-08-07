// The client's portal token. It is the ONLY thing standing between a mailed
// link and someone else's program, so the interesting assertions here are the
// negative ones.
//
// Env before import: lib/funnelLeadToken.ts derives every purpose key from
// process.env.JWT_SECRET at MODULE SCOPE, and a static import would hoist above
// these assignments. Reached through await import() for that reason.
process.env.JWT_SECRET = 'stub-secret-for-program-tokens'

import crypto from 'crypto'

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

// The token format, written out INDEPENDENTLY of the module under test. Used to
// forge payloads the signer would refuse to mint, so the verifier's own
// validation is exercised rather than the signer's. Mutating a shared helper
// would move the rule and the check together and the suite would pass while the
// bug ran.
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const derive = (label: string) => crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(label).digest()
function forge(label: string, payload: string): string {
  const sig = b64url(crypto.createHmac('sha256', derive(label)).update(payload).digest())
  return `${b64url(Buffer.from(payload, 'utf8'))}.${sig}`
}

const PROGRAM = '7f1c9a2e-3b4d-4e5f-8a90-1b2c3d4e5f60'
const T0 = 1_770_000_000_000
const YEAR_MS = 365 * 24 * 60 * 60 * 1000

;(async () => {
  const tok = await import('../lib/funnelLeadToken')
  const { signProgramToken, verifyProgramToken, PROGRAM_TTL_MS } = tok

  console.log('\n-- it round-trips, and version comes back as a NUMBER --')
  {
    const t = signProgramToken(PROGRAM, 1, T0)
    const d = verifyProgramToken(t, T0)
    eq('the program id survives', d?.programId, PROGRAM)
    eq('the version survives', d?.version, 1)

    // Stated separately from the value, because `'1' == 1` and JSON.stringify
    // would render them differently but a loose read would not. The caller does
    // `decoded.version !== row.portal_token_version` against an integer column;
    // a string here locks out every client while looking like a working check.
    ok('and it is a number, not the raw string segment', typeof d?.version === 'number', `got ${typeof d?.version}`)
    ok('so a strict compare against an integer column succeeds', d?.version === 1)

    const t9 = signProgramToken(PROGRAM, 9, T0)
    eq('a bumped version round-trips as itself', verifyProgramToken(t9, T0)?.version, 9)
  }

  console.log('\n-- revocation: the version is IN the token, so a bump orphans old links --')
  {
    // The lib cannot enforce revocation — the caller compares against the row.
    // What it must guarantee is that the version it returns is the one that was
    // signed, so that comparison can be made at all.
    const v1 = verifyProgramToken(signProgramToken(PROGRAM, 1, T0), T0)
    const v2 = verifyProgramToken(signProgramToken(PROGRAM, 2, T0), T0)
    eq('two versions of the same program decode differently', [v1?.version, v2?.version], [1, 2])
    ok('and both name the same program', v1?.programId === v2?.programId && v1?.programId === PROGRAM)
  }

  console.log('\n-- ONE PURPOSE, ONE KEY: the fixture that can actually tell --')
  {
    // THIS is the assertion the whole derived-key discipline exists for, and it
    // needs a fixture that isolates the KEY rather than the shape.
    //
    // A manage token is two segments and a program token is three, so a manage
    // token is refused on ARITY — it would be refused even if both purposes
    // shared one key. That check proves nothing about key separation.
    //
    // A WATCH token is "funnelId.leadId.expMs" — three segments. Signed with the
    // program id as the funnel and the string '1' as the lead, its payload is
    // byte-for-byte the shape of a program token at version 1. Everything is
    // held constant: same uuid, same '1', same clock. The ONLY difference left
    // is which key signed it.
    const watchLookalike = tok.signWatchToken(PROGRAM, '1', T0)
    eq('the lookalike is structurally a program token', watchLookalike.split('.').length, 2)
    const payload = Buffer.from(watchLookalike.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    eq('...with three payload segments, id then 1 then exp', [payload.split('.').length, payload.split('.')[0], payload.split('.')[1]], [3, PROGRAM, '1'])

    eq('a watch token does NOT verify as a program token', verifyProgramToken(watchLookalike, T0), null)

    // And the reverse, so neither key can impersonate the other.
    const programToken = signProgramToken(PROGRAM, 1, T0)
    eq('a program token does NOT verify as a watch token', tok.verifyWatchToken(programToken, PROGRAM, T0), null)
    eq('nor as an unsubscribe token', tok.verifyUnsubscribeToken(programToken, T0), null)
    eq('nor as an offer token', tok.verifyOfferToken(programToken, T0), null)
    eq('nor as an AI-coach token', tok.verifyCoachToken(programToken, T0), null)
    eq('nor as a booking manage token', tok.verifyManageToken(programToken, T0), null)

    // Weaker, but worth pinning: the arity refusal also holds.
    eq('a manage token does not verify as a program token (arity)', verifyProgramToken(tok.signManageToken(PROGRAM, T0), T0), null)
  }

  console.log('\n-- a forged payload our own key signed is still refused --')
  {
    // Signed correctly with the REAL program key, so the signature check passes
    // and only the payload validation can catch these. That is the point: a
    // signature proves we minted it, not that what we minted was well-formed.
    const L = 'client-program-portal-v1'
    const exp = T0 + YEAR_MS

    eq('a FRACTIONAL version breaks the split and is refused', verifyProgramToken(forge(L, `${PROGRAM}.1.5.${exp}`), T0), null)
    eq('version 0 is refused', verifyProgramToken(forge(L, `${PROGRAM}.0.${exp}`), T0), null)
    eq('a negative version is refused', verifyProgramToken(forge(L, `${PROGRAM}.-1.${exp}`), T0), null)
    eq('a non-numeric version is refused', verifyProgramToken(forge(L, `${PROGRAM}.abc.${exp}`), T0), null)
    eq('an empty program id is refused', verifyProgramToken(forge(L, `.1.${exp}`), T0), null)
    eq('a two-segment payload is refused', verifyProgramToken(forge(L, `${PROGRAM}.${exp}`), T0), null)
    eq('a non-numeric expiry is refused', verifyProgramToken(forge(L, `${PROGRAM}.1.later`), T0), null)

    // TRAILING JUNK, and this one earns its place. Destructuring three names off
    // a longer array succeeds silently, so a payload whose FIRST three segments
    // are valid decodes cleanly unless the arity is checked explicitly. Every
    // other malformed fixture above is caught by the expiry check instead —
    // deleting `segs.length !== 3` left the whole suite green until this line
    // existed, which made the arity check look redundant when it is not.
    eq('a valid triple with a fourth segment appended is refused', verifyProgramToken(forge(L, `${PROGRAM}.1.${exp}.extra`), T0), null)
    eq('and with several appended', verifyProgramToken(forge(L, `${PROGRAM}.1.${exp}.a.b`), T0), null)

    // The positive control. Without it, every line above would also pass against
    // a verifier that returns null unconditionally.
    ok('but a well-formed forgery of the same shape DOES verify', verifyProgramToken(forge(L, `${PROGRAM}.1.${exp}`), T0)?.version === 1)
  }

  console.log('\n-- the signer refuses to mint what the verifier would reject --')
  {
    const throws = (v: number) => {
      try {
        signProgramToken(PROGRAM, v, T0)
        return false
      } catch {
        return true
      }
    }
    ok('a fractional version throws rather than minting a dead link', throws(1.5))
    ok('version 0 throws', throws(0))
    ok('a negative version throws', throws(-1))
    ok('NaN throws', throws(NaN))
    ok('Infinity throws', throws(Infinity))
    ok('an unsafe integer throws', throws(Number.MAX_SAFE_INTEGER + 2))
    // The other side of the guard: legal values must NOT throw, or the guard is
    // just a broken signer.
    ok('version 1 mints fine', !throws(1))
    ok('a large but safe version mints fine', !throws(4096))
  }

  console.log('\n-- tampering --')
  {
    const t = signProgramToken(PROGRAM, 1, T0)
    const [p, s] = t.split('.')

    // Re-sign a DIFFERENT program under the right key, then keep the original
    // signature: the attack is swapping the payload, not corrupting it.
    const otherPayload = b64url(Buffer.from(`${PROGRAM.replace(/^7f/, '8f')}.1.${T0 + YEAR_MS}`, 'utf8'))
    eq('a swapped payload with the old signature is refused', verifyProgramToken(`${otherPayload}.${s}`, T0), null)
    eq('a corrupted signature is refused', verifyProgramToken(`${p}.${s.slice(0, -1)}X`, T0), null)
    eq('a truncated signature is refused', verifyProgramToken(`${p}.${s.slice(0, -4)}`, T0), null)
    eq('an empty signature is refused', verifyProgramToken(`${p}.`, T0), null)
    ok('and the untouched token still verifies', verifyProgramToken(t, T0) !== null)
  }

  console.log('\n-- constant-time compare, asserted at the source --')
  {
    // A TIMING property cannot be observed from an in-process unit test: swapping
    // timingSafeEqual for `!==` is functionally identical and every behavioural
    // assertion above passes either way. Verified by mutation — that swap left
    // the whole suite green.
    //
    // So this is asserted where it IS visible, the same way the settings tests
    // assert that a module does not call carryTimeOnto. Scoped to this function
    // rather than the file, or it would pass on a neighbour's usage.
    const { readFileSync } = await import('fs')
    const src = readFileSync('lib/funnelLeadToken.ts', 'utf8')
    const start = src.indexOf('export function verifyProgramToken')
    const body = start >= 0 ? src.slice(start, src.indexOf('\n// ----', start)) : ''
    ok('verifyProgramToken was located in source', start >= 0 && body.length > 0)
    ok('it compares signatures with crypto.timingSafeEqual', /crypto\.timingSafeEqual\(/.test(body), 'a plain === leaks signature bytes through timing')
    ok('and does not fall back to a plain string comparison', !/parts\[1\]\s*!==\s*expected/.test(body))
    // The length pre-check is required: timingSafeEqual THROWS on mismatched
    // lengths, so without it a truncated signature is a 500 rather than a 404.
    ok('with the length pre-check that stops timingSafeEqual throwing', /a\.length\s*!==\s*b\.length/.test(body))
  }

  console.log('\n-- expiry: a year, bounded by revocation rather than by time --')
  {
    eq('PROGRAM_TTL_MS is one year', PROGRAM_TTL_MS, YEAR_MS)

    const t = signProgramToken(PROGRAM, 1, T0)
    // Boundaries derived from the exported constant, not from a second literal.
    ok('valid the instant before expiry', verifyProgramToken(t, T0 + PROGRAM_TTL_MS - 1) !== null)
    eq('refused exactly at expiry', verifyProgramToken(t, T0 + PROGRAM_TTL_MS), null)
    eq('refused after expiry', verifyProgramToken(t, T0 + PROGRAM_TTL_MS + 1), null)
    ok('valid most of the way through a 16-week program plus a long pause', verifyProgramToken(t, T0 + 300 * 24 * 60 * 60 * 1000) !== null)
  }

  console.log('\n-- malformed input is refused, never thrown --')
  {
    const junk: unknown[] = [null, undefined, '', 'x', 'a.b.c', 0, 1, {}, [], true, false, 'not-base64!!.sig', '.']
    let refusedAll = true
    let threw = ''
    for (const j of junk) {
      try {
        if (verifyProgramToken(j, T0) !== null) refusedAll = false
      } catch (e) {
        threw = `${JSON.stringify(j)} threw ${String(e)}`
      }
    }
    ok('every malformed input returns null', refusedAll)
    // A public endpoint hands this whatever arrived in the query string. A throw
    // there is a 500 on a request that should be a quiet 404.
    eq('and nothing throws', threw, '')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
