process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

type Category = { id: string; name: string; slug: string; description: string | null; sort_order: number | null }

let categories: Category[] = []
let dbError: { message: string } | null = null
let lastUrl = ''

// The five live rows, verbatim from production after migration 081 — the
// three original seeds plus Closing Clients and Lead Generation.
function realFive(): Category[] {
  return [
    { id: 'adf61a6e-32d4-42ea-85af-3d747696a404', name: 'Wins & Results', slug: 'wins', description: 'Share your progress and celebrate milestones', sort_order: 1 },
    { id: 'e6e8b773-1cca-4393-86d7-df838de1e293', name: 'Ask the Community', slug: 'questions', description: 'Questions, feedback, and peer support', sort_order: 2 },
    { id: 'f1aa6fcf-9d83-4ac4-ac33-7d49ca23bf1d', name: 'Offer Reviews', slug: 'offers', description: 'Share your offer for feedback from the group', sort_order: 3 },
    { id: 'c0000000-0000-4000-8000-000000000004', name: 'Closing Clients', slug: 'closing', description: 'Sales calls, objections, and closing more deals', sort_order: 4 },
    { id: 'c0000000-0000-4000-8000-000000000005', name: 'Lead Generation', slug: 'leads', description: 'Traffic, ads, and generating more leads', sort_order: 5 },
  ]
}

// Applies the ORDER BY the endpoint asks for, rather than echoing rows back in
// insertion order — otherwise the ordering assertions below would pass no
// matter what the handler requested.
function applyOrder(url: string, rows: Category[]): Category[] {
  const keys = [...url.matchAll(/order=([^&]+)/g)].flatMap((m) =>
    decodeURIComponent(m[1]).split(',').map((s) => s.trim())
  )
  if (!keys.length) return rows
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [col] = key.split('.')
      const av = (a as any)[col]
      const bv = (b as any)[col]
      if (av === bv) continue
      // Postgres puts NULLs last on ASC by default.
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      return av < bv ? -1 : 1
    }
    return 0
  })
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/forum_categories')) {
    lastUrl = url
    if (dbError) return json({ message: dbError.message, code: 'XX000' }, 500)
    return json(applyOrder(url, categories))
  }
  return json([])
}) as typeof fetch

async function call(handler: Handler, opts: { method?: string; auth?: string } = {}) {
  let status = 0, body: any = null
  const headers: Record<string, string> = {}
  if (opts.auth) headers.authorization = opts.auth
  const res: any = {
    setHeader() {}, status(c: number) { status = c; return res },
    json(v: unknown) { body = v; return res }, end() { return res },
  }
  await handler({ method: opts.method || 'GET', headers, query: {}, body: undefined } as any, res)
  return { status, body }
}

;(async () => {
  const categoriesHandler: Handler = (await import('../api/forum/categories')).default

  console.log('\n-- returns all five live categories in display order --')
  categories = realFive()
  dbError = null
  const r = await call(categoriesHandler)
  ok('200', r.status === 200, JSON.stringify(r.body).slice(0, 200))
  ok('five categories, not the three hardcoded on the frontend', r.body?.categories?.length === 5, `got ${r.body?.categories?.length}`)
  ok(
    'ordered by sort_order',
    JSON.stringify(r.body?.categories?.map((c: Category) => c.slug)) ===
      JSON.stringify(['wins', 'questions', 'offers', 'closing', 'leads']),
    JSON.stringify(r.body?.categories?.map((c: Category) => c.slug))
  )
  ok(
    'each row carries id, name, slug, description, sort_order',
    r.body?.categories?.every((c: Category) => c.id && c.name && c.slug && c.description !== undefined && c.sort_order !== undefined)
  )

  console.log('\n-- the two new rows match the brief exactly --')
  const bySlug = Object.fromEntries((r.body?.categories || []).map((c: Category) => [c.slug, c]))
  ok('Closing Clients name', bySlug.closing?.name === 'Closing Clients', bySlug.closing?.name)
  ok('Closing Clients description', bySlug.closing?.description === 'Sales calls, objections, and closing more deals', bySlug.closing?.description)
  ok('Closing Clients sort_order 4', bySlug.closing?.sort_order === 4)
  ok('Lead Generation name', bySlug.leads?.name === 'Lead Generation', bySlug.leads?.name)
  ok('Lead Generation description', bySlug.leads?.description === 'Traffic, ads, and generating more leads', bySlug.leads?.description)
  ok('Lead Generation sort_order 5', bySlug.leads?.sort_order === 5)

  console.log('\n-- the original three are unchanged --')
  ok('wins still sort_order 1', bySlug.wins?.sort_order === 1)
  ok('questions still sort_order 2', bySlug.questions?.sort_order === 2)
  ok('offers still sort_order 3', bySlug.offers?.sort_order === 3)

  console.log('\n-- dynamic, not a hardcoded count: a sixth row just shows up --')
  categories = [...realFive(), { id: 'c0000000-0000-4000-8000-000000000006', name: 'Mindset', slug: 'mindset', description: 'Head game', sort_order: 6 }]
  const six = await call(categoriesHandler)
  ok('six returned with no code change', six.body?.categories?.length === 6)
  ok('new row lands last by sort_order', six.body?.categories?.[5]?.slug === 'mindset')

  console.log('\n-- ties on sort_order fall back to name, so the list is stable --')
  // sort_order is nullable with a default of 0, so seeding without one ties.
  categories = [
    { id: 'a', name: 'Zebra', slug: 'z', description: null, sort_order: 0 },
    { id: 'b', name: 'Alpha', slug: 'a', description: null, sort_order: 0 },
    { id: 'c', name: 'Middle', slug: 'm', description: null, sort_order: 0 },
  ]
  const tied = await call(categoriesHandler)
  ok(
    'tied rows come back alphabetical, not arbitrary',
    JSON.stringify(tied.body?.categories?.map((c: Category) => c.name)) === JSON.stringify(['Alpha', 'Middle', 'Zebra']),
    JSON.stringify(tied.body?.categories?.map((c: Category) => c.name))
  )
  // supabase-js collapses successive .order() calls into ONE comma-separated
  // order= param (order=sort_order.asc,name.asc) rather than emitting two.
  ok('handler asked the DB to order by both columns', /order=sort_order\.asc,name\.asc/.test(lastUrl), lastUrl)

  console.log('\n-- reads are public, same as the forum feed --')
  categories = realFive()
  const anon = await call(categoriesHandler)
  ok('no auth header still 200s', anon.status === 200)
  ok('and returns the full list', anon.body?.categories?.length === 5)
  const garbage = await call(categoriesHandler, { auth: 'Bearer not-a-real-token' })
  ok('a garbage token does not 401 — auth is simply not consulted', garbage.status === 200)

  console.log('\n-- empty table is an empty list, never null --')
  categories = []
  const empty = await call(categoriesHandler)
  ok('200', empty.status === 200)
  ok('categories is [] so the frontend can .map() it safely', Array.isArray(empty.body?.categories) && empty.body.categories.length === 0)

  console.log('\n-- a DB error is a 500, not a silently empty list --')
  categories = realFive()
  dbError = { message: 'connection reset' }
  const boom = await call(categoriesHandler)
  ok('500', boom.status === 500)
  ok('error message, no rows', !!boom.body?.error && !boom.body?.categories)
  dbError = null

  console.log('\n-- method guards --')
  categories = realFive()
  ok('POST 405s', (await call(categoriesHandler, { method: 'POST' })).status === 405)
  ok('DELETE 405s', (await call(categoriesHandler, { method: 'DELETE' })).status === 405)
  ok('PATCH 405s', (await call(categoriesHandler, { method: 'PATCH' })).status === 405)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
