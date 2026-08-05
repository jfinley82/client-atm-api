process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

// Dynamic imports below: lib/auth.ts encodes process.env.JWT_SECRET at module
// scope, and lib/supabase.ts builds its client the same way. A static import
// would let esbuild hoist both above the assignments here.
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

type User = { id: string; status: string; password_hash: string | null }
let users: Record<string, User> = {}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const method = (init?.method || 'GET').toUpperCase()
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) {
    const m = /[?&]id=eq\.([^&]+)/.exec(url)
    const id = m ? decodeURIComponent(m[1]) : null
    if (method === 'PATCH' && id) {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (users[id]) Object.assign(users[id], body)
      return json(users[id] ?? null)
    }
    return json(id && users[id] ? users[id] : null)
  }
  return json([])
}) as typeof fetch

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)

// Mint tokens directly so a session's origin and age can be set precisely —
// including shapes createSessionToken cannot produce, like a legacy token from
// before the origin claim existed.
async function mintToken(userId: string, opts: { origin?: string; ageSeconds?: number; omitOrigin?: boolean } = {}) {
  const iat = Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0)
  const payload: Record<string, unknown> = { userId }
  if (!opts.omitOrigin) payload.origin = opts.origin ?? 'password'
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime('1y')
    .sign(SECRET)
}

async function post(handler: Handler, token: string | null, body: unknown) {
  const req: any = { method: 'POST', headers: {}, body }
  if (token) req.headers.authorization = `Bearer ${token}`
  let status = 0
  let payload: any = null
  const res: any = {
    setHeader() {}, getHeader() { return undefined },
    status(c: number) { status = c; return res },
    json(b: unknown) { payload = b; return res },
    end() { return res },
  }
  await handler(req, res)
  return { status, body: payload }
}

;(async () => {
  const setPassword = (await import('../api/auth/set-password')).default as Handler
  const changePassword = (await import('../api/auth/change-password')).default as Handler
  const { createSessionToken, verifySessionToken, canSetPasswordWithoutCurrent, MAGIC_LINK_PASSWORD_GRACE_SECONDS } =
    await import('../lib/auth')

  // One hash reused everywhere the account "already has a password", so the
  // suite pays bcrypt's deliberate cost once rather than per case.
  const KNOWN = 'correct-horse-battery'
  const KNOWN_HASH = await bcrypt.hash(KNOWN, 12)

  function seed(id: string, password_hash: string | null) {
    users[id] = { id, status: 'active', password_hash }
    return id
  }

  console.log('\n-- the vulnerability: a live session alone can no longer take over the account --')
  {
    const id = seed('u-takeover', KNOWN_HASH)
    const stolen = await mintToken(id, { origin: 'password' })
    const r = await post(setPassword, stolen, { password: 'attacker-chosen-pw' })
    ok('set-password refuses when a password already exists', r.status === 403, `got ${r.status} ${JSON.stringify(r.body)}`)
    ok('and says which control is missing', r.body?.error === 'current_password_required', JSON.stringify(r.body))
    ok('the real password is untouched', users[id].password_hash === KNOWN_HASH)
    ok('the owner can still log in', await bcrypt.compare(KNOWN, users[id].password_hash!))
  }

  console.log('\n-- REGRESSION GUARD: magic-link first-time setup still works with no current password --')
  // This is the case a naive fix breaks. A brand-new member has no password to
  // present; if this 4xx's, onboarding is dead.
  {
    const id = seed('u-firsttime', null)
    const token = await createSessionToken(id, { origin: 'magic_link' })
    const r = await post(setPassword, token, { password: 'my-first-password' })
    ok('first-time set succeeds', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`)
    ok('a hash was written', typeof users[id].password_hash === 'string' && users[id].password_hash !== null)
    ok('the new password verifies', await bcrypt.compare('my-first-password', users[id].password_hash!))
  }
  {
    // Same case, but on a session minted BEFORE the origin claim existed — the
    // shape every already-logged-in member is holding on deploy day.
    const id = seed('u-firsttime-legacy', null)
    const legacy = await mintToken(id, { omitOrigin: true })
    const r = await post(setPassword, legacy, { password: 'legacy-session-pw' })
    ok('first-time set works on a legacy token too (no onboarding cliff)', r.status === 200, `got ${r.status}`)
    ok('and it wrote', await bcrypt.compare('legacy-session-pw', users[id].password_hash!))
  }

  console.log('\n-- forgot-password recovery: a FRESH magic-link session may reset without the current one --')
  {
    const id = seed('u-forgot', KNOWN_HASH)
    const token = await createSessionToken(id, { origin: 'magic_link' })
    const r = await post(setPassword, token, { password: 'brand-new-password' })
    ok('reset succeeds', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`)
    ok('the new password verifies', await bcrypt.compare('brand-new-password', users[id].password_hash!))
    ok('the old one no longer works', !(await bcrypt.compare(KNOWN, users[id].password_hash!)))
  }
  {
    const id = seed('u-forgot-stale', KNOWN_HASH)
    const stale = await mintToken(id, { origin: 'magic_link', ageSeconds: MAGIC_LINK_PASSWORD_GRACE_SECONDS + 60 })
    const r = await post(setPassword, stale, { password: 'too-late-password' })
    ok('a magic-link session past the grace window is refused', r.status === 403, `got ${r.status}`)
    ok('nothing was written', users[id].password_hash === KNOWN_HASH)
  }
  {
    const id = seed('u-forgot-edge', KNOWN_HASH)
    const edge = await mintToken(id, { origin: 'magic_link', ageSeconds: MAGIC_LINK_PASSWORD_GRACE_SECONDS - 30 })
    const r = await post(setPassword, edge, { password: 'just-in-time-pw' })
    ok('just inside the window is still allowed', r.status === 200, `got ${r.status}`)
  }

  console.log('\n-- change-password: the current password is actually verified --')
  {
    const id = seed('u-wrong', KNOWN_HASH)
    const token = await mintToken(id)
    const r = await post(changePassword, token, { current_password: 'not-my-password', password: 'replacement-pw' })
    ok('a wrong current password is rejected', r.status === 401, `got ${r.status} ${JSON.stringify(r.body)}`)
    ok('401 not 400 — a failed re-auth, not a malformed request', r.status === 401)
    ok('error names the mismatch', r.body?.error === 'current_password_incorrect', JSON.stringify(r.body))
    ok('field points the frontend at the right input', r.body?.field === 'current_password', JSON.stringify(r.body))
    ok('the password is unchanged', users[id].password_hash === KNOWN_HASH)
  }
  {
    const id = seed('u-right', KNOWN_HASH)
    const token = await mintToken(id)
    const r = await post(changePassword, token, { current_password: KNOWN, password: 'a-good-new-password' })
    ok('the correct current password is accepted', r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`)
    ok('the new password verifies', await bcrypt.compare('a-good-new-password', users[id].password_hash!))
    ok('the old password stops working', !(await bcrypt.compare(KNOWN, users[id].password_hash!)))
  }

  console.log('\n-- change-password: input validation --')
  {
    const id = seed('u-validate', KNOWN_HASH)
    const token = await mintToken(id)
    const missingCurrent = await post(changePassword, token, { password: 'long-enough-pw' })
    ok('missing current_password 400s', missingCurrent.status === 400, `got ${missingCurrent.status}`)
    ok('and names the field', missingCurrent.body?.field === 'current_password')

    const missingNew = await post(changePassword, token, { current_password: KNOWN })
    ok('missing new password 400s', missingNew.status === 400, `got ${missingNew.status}`)

    const tooShort = await post(changePassword, token, { current_password: KNOWN, password: 'short' })
    ok('a short new password 400s', tooShort.status === 400, `got ${tooShort.status}`)
    ok('and 400s BEFORE spending a bcrypt compare', tooShort.body?.field === 'password')
    ok('nothing was written by any invalid call', users[id].password_hash === KNOWN_HASH)
  }
  {
    const id = seed('u-nopassword', null)
    const token = await mintToken(id)
    const r = await post(changePassword, token, { current_password: 'anything', password: 'a-new-password' })
    ok('changing a password that does not exist 409s', r.status === 409, `got ${r.status}`)
    ok('and points at the link flow', r.body?.error === 'no_password_set', JSON.stringify(r.body))
  }

  console.log('\n-- change-password: repeated wrong guesses are throttled --')
  {
    const id = seed('u-bruteforce', KNOWN_HASH)
    const token = await mintToken(id)
    const codes: number[] = []
    for (let i = 0; i < 7; i++) {
      const r = await post(changePassword, token, { current_password: `guess-${i}`, password: 'replacement-pw' })
      codes.push(r.status)
    }
    ok('the first attempts are answered normally', codes.slice(0, 5).every((c) => c === 401), codes.join(','))
    ok('later attempts are throttled', codes.slice(5).every((c) => c === 429), codes.join(','))
    ok('throttling never lets a guess through', !codes.includes(200), codes.join(','))
    ok('the password survived the whole run', users[id].password_hash === KNOWN_HASH)

    // The throttle must not become a lockout for the legitimate owner on a
    // DIFFERENT account — it is keyed per user, not globally.
    const other = seed('u-not-throttled', KNOWN_HASH)
    const otherToken = await mintToken(other)
    const r = await post(changePassword, otherToken, { current_password: KNOWN, password: 'unaffected-pw' })
    ok('a different account is unaffected by the throttle', r.status === 200, `got ${r.status}`)
  }

  console.log('\n-- both endpoints still refuse an unauthenticated caller --')
  {
    ok('set-password 401s with no token', (await post(setPassword, null, { password: 'whatever-pw' })).status === 401)
    ok('change-password 401s with no token', (await post(changePassword, null, { current_password: 'a', password: 'whatever-pw' })).status === 401)
    const junk = 'not.a.jwt'
    ok('set-password 401s on a junk token', (await post(setPassword, junk, { password: 'whatever-pw' })).status === 401)
    ok('change-password 401s on a junk token', (await post(changePassword, junk, { current_password: 'a', password: 'whatever-pw' })).status === 401)
  }

  console.log('\n-- session claims --')
  {
    const token = await createSessionToken('u-claims', { origin: 'magic_link' })
    const claims = await verifySessionToken(token)
    ok('origin round-trips', claims?.origin === 'magic_link', JSON.stringify(claims))
    ok('issuedAt is stamped', typeof claims?.issuedAt === 'number')

    const plain = await createSessionToken('u-claims')
    ok('the default origin is password, not magic_link', (await verifySessionToken(plain))?.origin === 'password')

    const legacy = await verifySessionToken(await mintToken('u-legacy', { omitOrigin: true }))
    ok('a token with no origin claim reads as password', legacy?.origin === 'password', JSON.stringify(legacy))

    const forged = await verifySessionToken(await mintToken('u-forged', { origin: 'sudo' }))
    ok('an unrecognised origin collapses to password', forged?.origin === 'password', JSON.stringify(forged))
  }

  console.log('\n-- canSetPasswordWithoutCurrent --')
  {
    const now = 1_000_000
    ok('fresh magic link qualifies', canSetPasswordWithoutCurrent({ origin: 'magic_link', issuedAt: now - 60 }, now))
    ok('exactly at the boundary qualifies', canSetPasswordWithoutCurrent({ origin: 'magic_link', issuedAt: now - MAGIC_LINK_PASSWORD_GRACE_SECONDS }, now))
    ok('one second past does not', !canSetPasswordWithoutCurrent({ origin: 'magic_link', issuedAt: now - MAGIC_LINK_PASSWORD_GRACE_SECONDS - 1 }, now))
    ok('a password session never qualifies, however fresh', !canSetPasswordWithoutCurrent({ origin: 'password', issuedAt: now }, now))
    ok('no issuedAt does not qualify', !canSetPasswordWithoutCurrent({ origin: 'magic_link', issuedAt: null }, now))
    // A future-dated iat would otherwise pass the age check forever.
    ok('a future-dated token does not qualify', !canSetPasswordWithoutCurrent({ origin: 'magic_link', issuedAt: now + 500 }, now))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
