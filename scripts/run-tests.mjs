// Bundles and runs every tests/*.test.ts file, one child process per file — a
// fresh process each time since several test files set env vars (RESEND_API_KEY,
// SUPABASE_URL, ...) before importing lib/email.ts, which constructs its Resend
// client at module scope; a shared process would let one file's env leak into
// the next. Each test file prints its own PASS/FAIL lines and exits non-zero on
// failure, so this script does no assertion of its own — it only aggregates.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const testsDir = path.join(root, 'tests')

if (!fs.existsSync(testsDir)) {
  console.log('No tests/ directory found — nothing to run.')
  process.exit(0)
}

const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()

if (!files.length) {
  console.log('No *.test.ts files found in tests/.')
  process.exit(0)
}

// Built INSIDE node_modules (already gitignored), not os.tmpdir(): with
// --packages=external below, the bundle's require() calls for third-party
// packages need Node's normal upward node_modules resolution to actually find
// them, which only works if the output file lives under the project tree.
const tmpDir = fs.mkdtempSync(path.join(root, 'node_modules', '.gate-'))
let anyFailed = false

for (const file of files) {
  const src = path.join(testsDir, file)
  const out = path.join(tmpDir, file.replace(/\.ts$/, '.cjs'))
  console.log(`\n=== ${file} ===`)

  const build = spawnSync(
    'npx',
    // --packages=external: bundle only this repo's own source, not
    // node_modules — the same shape Vercel's Node.js runtime actually runs in
    // (real node_modules, real require()), not a single-file inline. Needed
    // for packages like email-reply-parser that read import.meta.url at
    // module scope: esbuild's --format=cjs empties import.meta when a
    // dependency is bundled in, but leaves it correct when Node loads the
    // real, unmodified package file itself.
    ['esbuild', src, '--bundle', '--platform=node', '--format=cjs', '--packages=external', `--outfile=${out}`],
    { stdio: 'inherit' }
  )
  if (build.status !== 0) {
    anyFailed = true
    console.error(`[gate] build failed: ${file}`)
    continue
  }

  const run = spawnSync(process.execPath, [out], { stdio: 'inherit' })
  if (run.status !== 0) anyFailed = true
}

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(anyFailed ? '\n[gate] one or more test files failed.' : '\n[gate] all test files passed.')
process.exit(anyFailed ? 1 : 0)
