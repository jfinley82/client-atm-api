process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'stub-anthropic'

import { deriveAudienceDisplayFields } from '../lib/audienceDisplay'

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

// docs/served-contract.md is GENERATED from the deriver. This file's job is to
// make sure it cannot silently stop describing the code — a contract that drifts
// is worse than no contract, because the frontend trusts it.
;(async () => {
  const { readFileSync, existsSync } = await import('fs')
  const { join } = await import('path')
  const { spawnSync } = await import('child_process')

  const docPath = join(process.cwd(), 'docs', 'served-contract.md')

  console.log('\n-- the contract exists and is current --')
  {
    ok('docs/served-contract.md is committed', existsSync(docPath))

    // Regenerate and compare. This is the assertion that matters: it runs the
    // real generator against the real deriver, so renaming a served key fails
    // here rather than reaching the frontend as a blank card.
    const check = spawnSync('node', ['scripts/served-contract.mjs', '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    ok(
      'and regenerating it produces no change',
      check.status === 0,
      (check.stdout || '') + (check.stderr || '') + '\n      run: node scripts/served-contract.mjs'
    )
  }

  console.log('\n-- the client-program serializers are in the contract, generated --')
  {
    const doc = readFileSync(docPath, 'utf8')
    for (const route of ['GET /api/client-programs', 'GET /api/client-programs/[id]', 'GET /api/client/program?t=']) {
      ok(`the contract documents ${route}`, doc.includes(`### \`${route}\``), 'run: node scripts/served-contract.mjs')
    }

    // Derived, not transcribed: a key only appears because the real serializer
    // returned it. Spot-checked on the ones that carry a rule — if these were
    // hand-written they could drift from the code silently, and the --check
    // above is what makes that impossible.
    for (const key of ['sessions_remaining', 'is_stalled', 'current_week', 'progress_pct', 'next_item.due_date']) {
      ok(`\`${key}\` is described`, doc.includes(`\`${key}\``))
    }

    // THE PORTAL'S OMISSIONS ARE PART OF THE CONTRACT. Scoped to that route's
    // table, because the coach routes legitimately carry some of these.
    const start = doc.indexOf('### `GET /api/client/program?t=`')
    const end = doc.indexOf('**The portal', start)
    ok('the portal section is locatable', start > 0 && end > start)
    const portalTable = doc.slice(start, end)
    for (const forbidden of ['user_id', 'lead_id', 'program_snapshot', 'portal_token_version', 'client_email', 'visibility']) {
      ok(`the portal contract does not list \`${forbidden}\``, !portalTable.includes(`\`${forbidden}\``), portalTable)
    }
    // Positive control: the portal table is not simply empty.
    ok('while the portal table does describe the programme', portalTable.includes('`program.client_name`'), portalTable)
  }

  console.log('\n-- every served key is documented, by value --')
  {
    const doc = readFileSync(docPath, 'utf8')

    // The deriver's ACTUAL output, over a probe that fills every shape. Asserted
    // against the document by name — not by counting, which would pass while
    // naming the wrong keys.
    const probe: Record<string, unknown> = {}
    const src = readFileSync(join(process.cwd(), 'lib/audienceDisplay.ts'), 'utf8')
    const fn = src.slice(
      src.indexOf('export function deriveAudienceDisplayFields'),
      src.indexOf('\n}', src.indexOf('export function deriveAudienceDisplayFields'))
    )
    for (const m of fn.matchAll(/\braw\.([a-z_][a-z0-9_]*)/gi)) probe[m[1]] = 'x'
    const asStrings = deriveAudienceDisplayFields(probe)
    for (const k of Object.keys(probe)) probe[k] = ['x']
    const asArrays = deriveAudienceDisplayFields(probe)
    const servedKeys = [...new Set([...Object.keys(asStrings), ...Object.keys(asArrays)])]

    ok('the deriver produces keys at all', servedKeys.length > 0)
    const missing = servedKeys.filter((k) => !doc.includes('`' + k + '`'))
    ok('every served key appears in the contract', missing.length === 0, missing.join(', '))
  }

  console.log('\n-- the traps the contract exists to prevent are stated --')
  {
    const doc = readFileSync(docPath, 'utf8')

    // The six whose served name is not a camelisation. Named individually, so
    // dropping one from the callout fails rather than shrinking a count.
    for (const [raw, servedName] of [
      ['sales_objections', 'objections'],
      ['tried_before', 'pastAttempts'],
      ['buying_triggers', 'buyingDecisions'],
      ['motivating_phrases', 'motivatingStatements'],
      ['repelling_phrases', 'turnAwayStatements'],
      ['where_to_find_them', 'whereToFind'],
    ]) {
      ok(`${raw} -> ${servedName} is called out`, doc.includes('`' + raw + '`') && doc.includes('`' + servedName + '`'))
    }

    // THE AVATAR HERO'S SIX, added because they had no camelCase alias and the
    // panel's only alternatives were to thin the hero or read raw keys — which
    // is how a second renderer starts. Asserted to be STRAIGHT camelisations:
    // four of the original nineteen are not, and that is what nearly cost four
    // blank cards, so any new key that breaks the rule has to be a decision
    // somebody made rather than one that slipped in.
    const camelise = (k: string) => k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())
    for (const rawKey of [
      'who_they_are',
      'their_world',
      'emotional_state',
      'internal_dialogue',
      'triggering_moment',
      'why_it_failed',
    ]) {
      const expected = camelise(rawKey)
      ok(`${rawKey} is served as ${expected}`, doc.includes('`' + expected + '`'), `not in the contract`)
      ok(`and ${expected} is a straight camelisation`, camelise(rawKey) === expected)
      // Scoped to the guesses-wrong table's OWN row shape (`raw` | **`served`**),
      // not to the raw key anywhere in the document — the per-section tables
      // carry the raw key too, so the looser pattern matched those and failed
      // on correct output.
      ok(
        `so ${expected} is NOT in the guesses-wrong table`,
        !new RegExp('\\| `' + rawKey + '` \\| \\*\\*`').test(doc),
        `${rawKey} was renamed — the contract must say why`
      )
    }
    // And the guesses-wrong list did not grow: still exactly the six known ones.
    const surpriseRows = (doc.match(/^\| `[a-z_]+` \| \*\*`/gm) || []).length
    ok(`the non-camelised list is still 6, not larger (${surpriseRows})`, surpriseRows === 6, `${surpriseRows}`)

    ok('avatar_gender is flagged as the snake_case exception', /deliberate snake_case exception/i.test(doc))
    ok('and the reason is given, not just the fact', /genderFromName|always carries a valid value/i.test(doc))

    // §19's "dedupe on build" is the line that would delete the keys the panel
    // reads. The contract has to say so explicitly, not merely disagree by
    // omission.
    ok('the contract states raw and derived are NOT duplicates', /NOT duplicates/i.test(doc))
    ok('and names the superseded spec line', doc.includes('dedupe on build') && /superseded/i.test(doc))

    // Steps 2 and 3.
    ok('Transform/Monetize are covered', /Steps 2 and 3/.test(doc))
    ok('and say there is no derived set', /no derived set/i.test(doc))
    ok(
      'and call out the beforeState / before_state split across tool_types',
      doc.includes('beforeState') && doc.includes('before_state') && /different keys in different tool_types/i.test(doc)
    )
  }

  console.log('\n-- nested shapes: names-only at one level is what left the gaps --')
  {
    const doc = readFileSync(docPath, 'utf8')

    // OTHER ANGLES' INNER KEYS. The frontend renders these with
    // Object.values(entry).filter(hasText) and prints the result with the first
    // line bold — so without the inner names it has no idea which value is the
    // reframe and which is the hint, and renders them in key order.
    ok('the otherAngles entry shape is documented', /Each `otherAngles\[n\]` entry/.test(doc))
    for (const inner of ['reframe', 'monetization_hint', 'monetizationHint']) {
      ok(`  inner key ${inner} is named`, doc.includes('`' + inner + '`'))
    }
    // The hint is served under BOTH spellings, so a values-based render prints
    // it twice. That has to be stated, not left to be discovered.
    ok('the double-spelling of the hint is called out', /served under two spellings/i.test(doc))
    ok('and reading by name is the stated instruction', /Read them BY NAME/.test(doc))

    // The inner shape must be GENERATED, not typed in — it comes from running
    // the deriver, so renaming an inner key updates the document.
    const probe: Record<string, unknown> = { other_angles: [{ reframe: 'r', monetization_hint: 'h' }] }
    const derivedAngles = (deriveAudienceDisplayFields(probe) as any).otherAngles?.[0] || {}
    for (const k of Object.keys(derivedAngles)) {
      ok(`  ${k} comes from the real deriver and is in the doc`, doc.includes('`' + k + '`'))
    }

    // FRAMEWORK, which had no entry at all.
    ok('framework is a documented tool_type', /### `framework`/.test(doc))
    for (const p of ['frameworkName', 'phases[n].steps[n]', 'name_options[n]']) {
      ok(`  ${p} is present`, doc.includes(p), 'the depth pass missed it')
    }
    ok('and depth 3 is flagged as such', /DEPTH 3/.test(doc))

    // SELECTED PROBLEMS — seven of eleven fields are objects.
    for (const p of [
      'selectedProblems[n].rootCause.corePattern',
      'selectedProblems[n].rootDesire.emotionalDesire',
      'selectedProblems[n].costOfInaction.action',
      'selectedProblems[n].objectionReframe.objection',
      'selectedProblems[n].marketingTranslation.startSaying',
    ]) {
      ok(`  ${p} is documented`, doc.includes(p), 'a nested object stopped at its outer key')
    }

    // THE TWO-DEPTH, TWO-TYPE COLLISION. Made visible by path-qualifying rather
    // than by listing the bare name twice, which would read as a duplicate.
    ok('the two-depth beforeState collision is called out', /TWO DEPTHS/.test(doc) && /TWO DIFFERENT TYPES/.test(doc))
    ok(
      'the top-level one is marked as a string',
      /\| `beforeState` \| string \| TOP-LEVEL/.test(doc),
      'the top-level beforeState is not marked as the string it is'
    )
    ok(
      'the nested one is marked as an object',
      /\| `selectedProblems\[n\]\.beforeState` \| object \| NESTED/.test(doc),
      'the nested beforeState is not marked as the object it is'
    )
    ok('and the nested children are named', doc.includes('beliefs') && doc.includes('internalTalk') && doc.includes('results'))
    ok('with the reason paths are used at all', /the path is the name/i.test(doc))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
