#!/usr/bin/env node
/**
 * Applies pending supabase/migrations/*.sql against DATABASE_URL.
 *
 * Why not `supabase db push`: this project's migration history was applied by
 * hand, so supabase_migrations.schema_migrations holds inconsistent names and
 * ad-hoc versions (044_…, 077_…, bare `funnel_covers`) that don't map back to
 * the files. Reconciling that is riskier than tracking filenames ourselves, so
 * this runner keeps its own table and never touches Supabase's.
 *
 * Usage:
 *   node scripts/migrate.mjs              apply anything not yet recorded
 *   node scripts/migrate.mjs --backfill   record every existing file as applied
 *   node scripts/migrate.mjs --dry-run    list what would apply, change nothing
 *
 * Exit codes: 0 success, 1 failure (CI fails the job).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')

const TRACKING_DDL = `
  create table if not exists public.applied_migrations (
    filename text primary key,
    applied_at timestamptz default now()
  );
`

function migrationFiles() {
  // Sorted by filename — the numeric prefixes make that the intended order.
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

async function trackingTableExists(client) {
  const { rows } = await client.query(`select to_regclass('public.applied_migrations') as reg`)
  return rows[0]?.reg !== null
}

async function appliedSet(client) {
  const { rows } = await client.query('select filename from public.applied_migrations')
  return new Set(rows.map((r) => r.filename))
}

async function backfill(client, files) {
  await client.query(TRACKING_DDL)
  const before = (await appliedSet(client)).size
  await client.query(
    `insert into public.applied_migrations (filename)
     select unnest($1::text[])
     on conflict (filename) do nothing`,
    [files],
  )
  const after = (await appliedSet(client)).size

  console.log(`Backfill complete.`)
  console.log(`  migration files on disk : ${files.length}`)
  console.log(`  rows before             : ${before}`)
  console.log(`  rows inserted           : ${after - before}`)
  console.log(`  rows now                : ${after}`)
  if (after !== files.length) {
    console.warn(
      `\n!! ${after} rows vs ${files.length} files — a row exists with no matching file, ` +
        `or a file was added after this run. Reconcile before relying on the runner.`,
    )
  }
  return after === files.length ? 0 : 1
}

async function apply(client, files, dryRun) {
  const existed = await trackingTableExists(client)
  await client.query(TRACKING_DDL)

  const done = existed ? await appliedSet(client) : new Set()
  const pending = files.filter((f) => !done.has(f))

  // The guard that makes this safe to merge before the backfill has been run:
  // an absent tracking table means nothing has ever been recorded, so every
  // historical migration looks pending — and re-running historical DDL against
  // a live database is exactly the accident this script exists to prevent.
  if (!existed && pending.length > 0) {
    console.error(
      `Refusing to run: public.applied_migrations did not exist, so all ${pending.length} ` +
        `migrations look pending.\n` +
        `If this database already has the schema, run the one-time backfill first:\n` +
        `  npm run migrate:backfill\n` +
        `If this is a genuinely empty database, run the backfill against it only after ` +
        `confirming that is what you want.`,
    )
    return 1
  }

  if (pending.length === 0) {
    console.log(`Nothing to apply. ${files.length} file(s), all already recorded.`)
    return 0
  }

  if (dryRun) {
    console.log(`Would apply ${pending.length} migration(s):`)
    for (const f of pending) console.log(`  ${f}`)
    return 0
  }

  let applied = 0
  for (const filename of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
    // One transaction per file: a failure rolls that file back whole, so a
    // migration is never half-applied and never recorded unless it succeeded.
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('insert into public.applied_migrations (filename) values ($1)', [filename])
      await client.query('COMMIT')
      applied += 1
      console.log(`applied  ${filename}`)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      console.error(`\nFAILED   ${filename}`)
      console.error(err instanceof Error ? err.message : String(err))
      console.error(`\nRolled back. ${applied} migration(s) applied before this one.`)
      return 1
    }
  }

  console.log(`\nApplied ${applied}, skipped ${files.length - pending.length}.`)
  return 0
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
  }

  const files = migrationFiles()
  // Supabase terminates non-TLS connections; the pooler presents a cert chain
  // Node does not ship a root for, hence the relaxed verification.
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
  await client.connect()

  let code = 1
  try {
    code = args.has('--backfill')
      ? await backfill(client, files)
      : await apply(client, files, args.has('--dry-run'))
  } finally {
    await client.end().catch(() => {})
  }
  process.exit(code)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
