// PostgREST response fidelity for the test stubs.
//
// A stub that hands back its whole fixture regardless of what `select=` asked
// for makes every "the handler reads this column" guard untestable: the column
// can be deleted from the query and the assertion about it still passes, because
// the stub supplies it anyway. That is the decorative-guard shape from CLAUDE.md
// wearing a real comparison — the assertion is correctly worded and its subject
// is something the fixture cannot withhold.
//
// Measured on a clean tree before this existed: dropping `zoom_join_url` or
// `meeting_url` from BOOKING_COLUMNS, or `application_submitted_at` from
// LEAD_COLUMNS, each left the whole gate green. The third is the sharpest —
// tests/calendar.test.ts asserts "approved_at comes from
// application_submitted_at" by name, and passed with the column removed from the
// select.
//
// One implementation, imported by every stub, because the alternative is these
// twenty lines copied into thirty-six files and drifting — the same failure the
// two `bookings` scoping rules had before lib/coachBookings.ts.
//
// NOT a spelling test for the constants. It models what PostgREST does and
// nothing more: adding a column no handler reads changes no output, so this
// cannot be satisfied by keeping a constant in sync with a fixture.

type Column = { out: string; src: string }

// Splits on top-level commas only. An embedded resource — `funnels(id,name)` —
// carries its own commas, and a naive split would shred it into fragments that
// match no key and silently withhold the whole relation.
function splitTopLevel(spec: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of spec) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

function parseColumns(spec: string): Column[] | null {
  // `*` means everything; there is nothing to withhold.
  if (/(^|,)\s*\*\s*(,|$)/.test(spec)) return null

  const cols: Column[] = []
  for (const raw of splitTopLevel(spec)) {
    // An embedded resource keeps its own key: `funnels(id, name)` -> `funnels`.
    const base = raw.includes('(') ? raw.slice(0, raw.indexOf('(')).trim() : raw
    // `alias:column` renames on the way out, so the RESPONSE carries the alias
    // and the fixture carries the column.
    const colon = base.indexOf(':')
    if (colon > 0) {
      cols.push({ out: base.slice(0, colon).trim(), src: base.slice(colon + 1).trim() })
    } else {
      // `col::text` casts are stripped to the column name.
      const name = base.split('::')[0].trim()
      if (name) cols.push({ out: name, src: name })
    }
  }
  return cols.length ? cols : null
}

function projectRow(row: unknown, cols: Column[]): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  const src = row as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const c of cols) {
    // Read the source key, fall back to the output key so a fixture written
    // against the alias still works. A column present in neither is OMITTED
    // rather than set to undefined — that is what a column the query never
    // asked for looks like.
    if (c.src in src) out[c.out] = src[c.src]
    else if (c.out in src) out[c.out] = src[c.out]
  }
  return out
}

/**
 * Withhold whatever `select=` did not ask for.
 *
 * Pass the request URL, the body the stub is about to return, and the status it
 * will carry. Anything that is not a PostgREST read, or that selects `*`, comes
 * back untouched — so this is safe to apply to every response a stub emits,
 * including Zoom, Resend and plain `{ ok: true }` bodies.
 *
 * ERRORS ARE NEVER PROJECTED. PostgREST reports a failure as a non-2xx carrying
 * { code, message, details, hint }, and `select=` says nothing about that shape.
 * Projecting it strips `code`, so a handler branching on '23505' sees undefined
 * and returns a 500 where it should return a 409. That is not hypothetical: it
 * is what this function did to api/admin/courses on its first run, and the two
 * assertions it broke were the ones checking a unique-violation becomes an
 * actionable 409 rather than a 500.
 */
export function projectSelect<T>(url: string, body: T, status = 200): T {
  if (status >= 300) return body
  if (!url.includes('/rest/v1/')) return body
  const m = /[?&]select=([^&]+)/.exec(url)
  if (!m) return body

  let spec: string
  try {
    spec = decodeURIComponent(m[1])
  } catch {
    spec = m[1]
  }

  const cols = parseColumns(spec)
  if (!cols) return body
  if (Array.isArray(body)) return body.map((r) => projectRow(r, cols)) as unknown as T
  return projectRow(body, cols) as unknown as T
}

/**
 * `ilike`/`like` MODELLED AS A PATTERN, because that is what Postgres does.
 *
 * A stub that compares the value literally cannot see the defect this exists to
 * catch: an unescaped `%` from a stored address matches every row, and a
 * literal-comparison stub reports a clean bill of health on precisely the input
 * that is broken. Same class as the projection helper above — a mock that cannot
 * answer wrongly cannot test the code that depends on it answering rightly.
 *
 * `\` is the escape character, so `\%` is a literal per cent.
 */
export function ilikeMatches(pattern: string, value: unknown): boolean {
  const special = /[.*+?^${}()|[\]\\]/g
  let rx = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[++i]
      if (next !== undefined) rx += next.replace(special, '\\$&')
      continue
    }
    if (ch === '%') rx += '.*'
    else if (ch === '_') rx += '.'
    else rx += ch.replace(special, '\\$&')
  }
  return new RegExp(`^${rx}$`, 'i').test(String(value ?? ''))
}

/**
 * `count: 'exact'` LIVES IN A HEADER, not in the body.
 *
 * PostgREST answers a counted request with `Content-Range: 0-24/3573`, and
 * supabase-js reads the total from there. A stub that returns only a body leaves
 * `count` undefined, so `count ?? 0` is 0 on every path — and any assertion about
 * a count passes whatever the query actually matched. Measured: the discovery
 * -count guard could not fail until this existed.
 *
 * `head: true` additionally means the body is empty and only the count matters.
 */
export function countHeaders(url: string, init: any, total: number): Record<string, string> {
  const h = init?.headers
  const prefer = h && typeof h.get === 'function' ? h.get('Prefer') : h?.Prefer ?? h?.prefer
  if (!/count=/.test(String(prefer || ''))) return {}
  void url
  return { 'Content-Range': total === 0 ? `*/0` : `0-${total - 1}/${total}` }
}
