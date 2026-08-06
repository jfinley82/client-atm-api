process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'stub-anthropic'

import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

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

const COACH = 'coach-1'

// ---------------------------------------------------------------------------
// AN OLD ROW, AS AN OLD ROW ACTUALLY LOOKS.
//
// This is the fixture that would have caught the defect and did not exist:
// raw snake_case only, NO camelCase aliases at all. Every previous test called
// deriveAudienceDisplayFields directly, so all of them exercised a fresh
// derivation and none exercised a row written before an alias existed.
//
// Measured on the live payload: the one real profile in the system carries
// who_they_are (245 chars), their_world (196), emotional_state (193),
// internal_dialogue (178), triggering_moment (129) and why_it_failed (241) —
// and returned whoTheyAre, theirWorld, emotionalState, internalDialogue,
// triggeringMoment and whyItFailed all undefined, because the row predates
// those six aliases and the GET returned stored content unchanged.
// ---------------------------------------------------------------------------
const OLD_ROW_RAW: Record<string, unknown> = {
  avatar_name: 'Sarah the Overwhelmed Coach',
  problem_statement: 'she cannot say what she does in one sentence',
  who_they_are: 'a one-to-one coach five years in, competent and invisible',
  their_world: 'referrals, a full calendar of the wrong clients, no pipeline',
  emotional_state: 'quietly exhausted and starting to doubt the whole thing',
  internal_dialogue: 'maybe I am just not good at the business side',
  perceived_problem: 'she thinks she needs better marketing',
  real_problem: 'she has never compressed her offer into one sellable promise',
  gap_insight: 'the marketing is fine; there is nothing specific for it to carry',
  pain_points: ['discounting to close', 'every month restarts from zero'],
  fears_and_doubts: ['that she is not actually an expert', 'that raising prices ends it'],
  dream_outcome: 'a predictable month she can plan around',
  motivating_phrases: ['finally clear', 'people just get it now'],
  repelling_phrases: ['scale', 'six figures'],
  language_problem: ['I am busy but broke'],
  language_solution: ['I know exactly who I help'],
  buying_triggers: ['a month with no new clients'],
  sales_objections: ['I should be able to figure this out myself'],
  tried_before: ['a course on funnels', 'hiring a VA'],
  why_it_failed: 'none of it addressed the offer itself, only the traffic to it',
  where_to_find_them: ['coaching Facebook groups', 'podcasts about pricing'],
  other_angles: [{ reframe: 'the positioning problem', monetization_hint: 'a paid clarity intensive' }],
  triggering_moment: 'a discovery call that went nowhere for the fourth time',
  monetize_bridge: 'the clarity work becomes the first paid engagement',
  connection_summary: 'she needs to be told the problem is not effort',
  // Bookkeeping the panel does not render, kept so the fixture is a real row.
  completed: true,
  session_history: [{ role: 'user', content: 'hello' }],
}

// Sanity: this fixture must contain NO camelCase key, or it is not an old row.
const CAMEL_IN_FIXTURE = Object.keys(OLD_ROW_RAW).filter((k) => /[A-Z]/.test(k))

let savedRow: { tool_type: string; content: Record<string, unknown> } | null = null

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/saved_outputs')) {
    if (!savedRow) return url.includes('tool_type=eq.') ? json(null) : json([])
    // Single-row reads use .maybeSingle(); the list read returns an array.
    const single = /tool_type=eq\./.test(url)
    const row = { tool_type: savedRow.tool_type, content: savedRow.content, created_at: '2026-08-01T00:00:00Z' }
    return single ? json(row) : json([row])
  }
  if (url.includes('/rest/v1/users')) {
    return json({ id: COACH, status: 'active', role: 'user' })
  }
  return json({})
}) as typeof fetch

function makeRes() {
  const out: any = { status: 0, body: null }
  const res: any = {
    setHeader() {},
    status(c: number) {
      out.status = c
      return res
    },
    json(v: unknown) {
      out.body = v
      return res
    },
    end() {
      return res
    },
  }
  return { res, out }
}

;(async () => {
  const audience: Handler = (await import('../api/tools/audience')).default
  const saved: Handler = (await import('../api/tools/saved')).default
  const { audienceForDisplay } = await import('../lib/audienceDisplay')
  const { readFileSync } = await import('fs')
  const { join } = await import('path')

  async function get(handler: Handler, query: Record<string, unknown> = {}) {
    const r = makeRes()
    await handler(
      { method: 'GET', headers: { authorization: `Bearer ${await createSessionToken(COACH)}` }, query },
      r.res
    )
    return r.out
  }

  console.log('\n-- the fixture is genuinely an OLD row --')
  {
    ok('it carries no camelCase key at all', CAMEL_IN_FIXTURE.length === 0, CAMEL_IN_FIXTURE.join(', '))
    ok('but it does carry the raw hero fields', typeof OLD_ROW_RAW.who_they_are === 'string')
    // If this ever stops being true the test is measuring a fresh row and proves
    // nothing about the defect it exists for.
    ok('and none of the six aliases is present', ['whoTheyAre', 'theirWorld', 'emotionalState', 'internalDialogue', 'triggeringMoment', 'whyItFailed'].every((k) => !(k in OLD_ROW_RAW)))
  }

  console.log('\n-- THE PROPERTY: every published key resolves at read time --')
  // Not "the six appear" — that is the example. The property is that ANY saved
  // profile resolves EVERY key in the published contract, whenever it was
  // written. The contract is the generated document, read here rather than
  // re-listed, so adding a key to the deriver extends this assertion for free.
  {
    savedRow = { tool_type: 'audience', content: { ...OLD_ROW_RAW } }

    const doc = readFileSync(join(process.cwd(), 'docs', 'served-contract.md'), 'utf8')
    // The contract's per-section tables: | `servedName` | type | `raw_key` |
    const contractKeys = [...doc.matchAll(/^\| `([A-Za-z_]+)` \| [^|]+ \| `([a-z_]+)/gm)].map((m) => ({
      servedName: m[1],
      rawKey: m[2],
    }))
    ok(`the contract lists keys to check (${contractKeys.length})`, contractKeys.length > 20, `${contractKeys.length}`)

    for (const [label, out] of [
      ['GET /api/tools/audience', await get(audience)],
      ['GET /api/tools/saved?tool_type=audience', await get(saved, { tool_type: 'audience' })],
    ] as Array<[string, any]>) {
      const profile = (label.includes('saved') ? out.body?.content : out.body?.output) as Record<string, unknown>
      ok(`${label} returns a profile`, !!profile, JSON.stringify(out.body).slice(0, 200))

      const unresolved = contractKeys
        // Only keys whose raw source is actually in this row — a key with no raw
        // value is correctly absent, and asserting it would be asserting the
        // fixture rather than the code.
        .filter(({ rawKey }) => OLD_ROW_RAW[rawKey] !== undefined)
        .filter(({ servedName }) => profile?.[servedName] === undefined)
        .map(({ servedName, rawKey }) => `${servedName} (from ${rawKey})`)

      ok(`${label}: every contract key resolves`, unresolved.length === 0, unresolved.join(', '))
    }
  }

  console.log('\n-- the reported example, by name --')
  {
    const out = await get(audience)
    const profile = out.body?.output as Record<string, unknown>
    for (const [alias, rawKey] of [
      ['whoTheyAre', 'who_they_are'],
      ['theirWorld', 'their_world'],
      ['emotionalState', 'emotional_state'],
      ['internalDialogue', 'internal_dialogue'],
      ['triggeringMoment', 'triggering_moment'],
      ['whyItFailed', 'why_it_failed'],
    ]) {
      ok(`${alias} resolves`, profile[alias] === OLD_ROW_RAW[rawKey], `${JSON.stringify(profile[alias])}`)
    }
    // And the raw fields are STILL THERE. The Funnel Builder's MTM Adapter reads
    // them; deriving on read adds, it does not replace.
    ok('the raw fields survive alongside', OLD_ROW_RAW && profile.who_they_are === OLD_ROW_RAW.who_they_are)
    ok('the transcript is still stripped', !('session_history' in profile))
    ok('and bookkeeping passes through', profile.completed === true)
  }

  console.log('\n-- the persona avatar resolves, and resolves the SAME every time --')
  {
    savedRow = { tool_type: 'audience', content: { ...OLD_ROW_RAW } }
    const out = await get(audience)
    const profile = out.body?.output as Record<string, unknown>

    // NAMED personaAvatarUrl, not avatarUrl. users.avatar_url is the COACH's own
    // account photo — the private field this repo spent a day keeping off public
    // surfaces — so a key called `avatarUrl` on a profile payload is one careless
    // read from wiring the wrong one.
    ok('personaAvatarUrl is served', typeof profile.personaAvatarUrl === 'string', JSON.stringify(profile.personaAvatarUrl))
    ok('and it is NOT called avatarUrl', !('avatarUrl' in profile), 'a name that collides with the coach account photo')
    ok('it points at the avatars path', String(profile.personaAvatarUrl).includes('/avatars/'))
    ok('and at an svg', /\.svg$/.test(String(profile.personaAvatarUrl)), String(profile.personaAvatarUrl))

    // It works on an OLD row — the fixture has no camelCase at all — which is the
    // same read-time rule as the six hero fields.
    ok('it resolves for a row written before it existed', !!profile.personaAvatarUrl)

    // STABILITY IS THE ENTIRE REASON THE HELPER EXISTS: the same persona must
    // resolve to the same face on the Audience band, the Launch persona tile and
    // every Launch library card. Asserted by resolving twice and comparing, not
    // by reading the hash function.
    const second = await get(audience)
    ok(
      'the same profile resolves to the same URL twice',
      (second.body?.output as any)?.personaAvatarUrl === profile.personaAvatarUrl,
      `${(second.body?.output as any)?.personaAvatarUrl} vs ${profile.personaAvatarUrl}`
    )

    // And "stable" must not mean "constant" — a different persona has to land
    // somewhere else, or the seed is doing nothing.
    //
    // BOTH PERSONAS ARE PINNED TO THE SAME GENDER, and that is the whole point of
    // the fixture. The first version compared Sarah against Marcus, which land in
    // different gender BUCKETS — so they differed even with the seed ignored
    // entirely, and a mutation replacing the seed with a constant passed the
    // suite. Same bucket means only the seed can separate them.
    savedRow = {
      tool_type: 'audience',
      content: { ...OLD_ROW_RAW, avatar_name: 'Sarah the Overwhelmed Coach', avatar_gender: 'feminine' },
    }
    const sameGenderBase = await get(audience)
    savedRow = {
      tool_type: 'audience',
      content: { ...OLD_ROW_RAW, avatar_name: 'Priya the Stalled Founder', avatar_gender: 'feminine' },
    }
    const other = await get(audience)
    ok(
      'a different persona in the SAME gender bucket resolves to a different face',
      (other.body?.output as any)?.personaAvatarUrl !== (sameGenderBase.body?.output as any)?.personaAvatarUrl,
      `both landed on ${(other.body?.output as any)?.personaAvatarUrl} — the seed is not being used`
    )

    // Seeded from the NAME when there is one. Same name, different everything
    // else, must give the same face.
    savedRow = { tool_type: 'audience', content: { avatar_name: OLD_ROW_RAW.avatar_name } }
    const nameOnly = await get(audience)
    ok(
      'the name alone determines it',
      (nameOnly.body?.output as any)?.personaAvatarUrl === profile.personaAvatarUrl,
      'something other than the persona seed is feeding the choice'
    )

    // No name yet: still a face, seeded from the coach id, so the band is not
    // empty before the persona is named.
    savedRow = { tool_type: 'audience', content: { who_they_are: 'someone' } }
    const unnamed = await get(audience)
    ok(
      'an unnamed persona still resolves, seeded from the coach',
      typeof (unnamed.body?.output as any)?.personaAvatarUrl === 'string',
      JSON.stringify((unnamed.body?.output as any)?.personaAvatarUrl)
    )

    savedRow = { tool_type: 'audience', content: { ...OLD_ROW_RAW } }
  }

  console.log('\n-- deriving on read repairs, it does not overwrite --')
  {
    // A row carrying a STALE alias — one whose raw source has since changed —
    // must come back agreeing with the raw field, not with the stored copy.
    // Spreading derived last is what makes that true; spreading it first would
    // preserve exactly the staleness this change exists to remove.
    savedRow = {
      tool_type: 'audience',
      content: { ...OLD_ROW_RAW, dreamOutcome: 'A STALE VALUE FROM AN OLDER TURN' },
    }
    const out = await get(audience)
    const profile = out.body?.output as Record<string, unknown>
    ok(
      'a stale stored alias is corrected from the raw field',
      profile.dreamOutcome === OLD_ROW_RAW.dream_outcome,
      JSON.stringify(profile.dreamOutcome)
    )
  }

  console.log('\n-- non-audience rows and empty rows are untouched --')
  {
    savedRow = { tool_type: 'transformation', content: { before_state: 'x', after_state: 'y' } }
    const out = await get(saved, { tool_type: 'transformation' })
    ok(
      'a transformation row gets no audience aliases',
      !('whoTheyAre' in (out.body?.content || {})) && out.body?.content?.before_state === 'x',
      JSON.stringify(out.body?.content)
    )

    savedRow = null
    const none = await get(audience)
    ok('no saved row still returns output: null', none.body?.output === null, JSON.stringify(none.body))
    ok('and exists: false', none.body?.exists === false)
    // Not an empty object — callers tell "no conversation yet" from "a
    // conversation with nothing in it" by this.
    ok('null stays null rather than becoming {}', none.body?.output !== undefined && none.body.output === null)
  }

  console.log('\n-- audienceForDisplay itself --')
  {
    ok('null passes through', audienceForDisplay(null) === null)
    ok('undefined passes through', audienceForDisplay(undefined) === undefined)
    ok('an array passes through untouched', JSON.stringify(audienceForDisplay([1, 2])) === '[1,2]')
    ok('a string passes through', audienceForDisplay('x') === 'x')
    const twice = audienceForDisplay(audienceForDisplay({ ...OLD_ROW_RAW }))
    const once = audienceForDisplay({ ...OLD_ROW_RAW })
    ok('it is idempotent', JSON.stringify(twice) === JSON.stringify(once))
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
