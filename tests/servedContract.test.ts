process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.ANTHROPIC_API_KEY = 'stub-anthropic'

import { deriveAudienceDisplayFields } from '../api/tools/chat'

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

  console.log('\n-- every served key is documented, by value --')
  {
    const doc = readFileSync(docPath, 'utf8')

    // The deriver's ACTUAL output, over a probe that fills every shape. Asserted
    // against the document by name — not by counting, which would pass while
    // naming the wrong keys.
    const probe: Record<string, unknown> = {}
    const src = readFileSync(join(process.cwd(), 'api/tools/chat.ts'), 'utf8')
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

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
