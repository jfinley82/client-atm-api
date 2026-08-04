process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'
process.env.RESEND_API_KEY = 'stub-resend-key'

// Dynamic imports: every handler here reaches lib/email.ts, which constructs
// `new Resend(process.env.RESEND_API_KEY!)` at module scope. A static import
// would let esbuild run that before the env assignment above.
import { createSessionToken } from '../lib/auth'

type Handler = (req: any, res: any) => Promise<void>

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log('  PASS', label) }
  else { fail++; console.log('  FAIL', label, extra ? '\n      ' + extra : '') }
}

const MEMBER = 'member-1'
const OTHER_MEMBER = 'member-2'
const ADMIN = 'admin-1'
const FUNNEL = 'funnel-1'
const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

let users: Record<string, any> = {}
let funnels: any[] = []
let tickets: any[] = []
let messages: any[] = []
let resendSends: any[] = []

function eqParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=eq\\.([^&]+)`).exec(url)
  return m ? decodeURIComponent(m[1]) : null
}
function inParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=in\\.\\(([^)]*)\\)`).exec(url)
  return m ? m[1].split(',').map((s) => decodeURIComponent(s).replace(/^"|"$/g, '')) : null
}
// Greedy so a nested clause like `user_id.in.(a,b)` inside the outer `or=(...)`
// doesn't truncate the match at its own inner ")".
function orParam(url: string, key: string) {
  const m = new RegExp(`[?&]${key}=\\((.*)\\)(?=&|$)`).exec(url)
  return m ? m[1] : null
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const method = (init?.method || 'GET').toUpperCase()
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('api.resend.com/emails')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    resendSends.push(body)
    return json({ id: `msg-${resendSends.length}` })
  }

  if (url.includes('/rest/v1/users')) {
    const id = eqParam(url, 'id')
    const ids = inParam(url, 'id')
    const orClause = orParam(url, 'or')
    if (id) return json(users[id] ? { id, ...users[id] } : null)
    if (ids) return json(ids.map((i) => ({ id: i, ...users[i] })).filter((u) => u.name !== undefined || u.email !== undefined))
    if (orClause) {
      // name.ilike.%x%,email.ilike.%x%
      const m = /(?:name|email)\.ilike\.%([^%,]*)%/.exec(orClause)
      const needle = (m?.[1] || '').toLowerCase()
      const matches = Object.entries(users)
        .filter(([, u]) => (u.name || '').toLowerCase().includes(needle) || (u.email || '').toLowerCase().includes(needle))
        .map(([id, u]) => ({ id, ...u }))
      return json(matches)
    }
    return json(null)
  }

  if (url.includes('/rest/v1/funnels')) {
    const id = eqParam(url, 'id')
    const owner = eqParam(url, 'user_id')
    return json(funnels.find((f) => f.id === id && (!owner || f.user_id === owner)) ?? null)
  }

  if (url.includes('/rest/v1/support_ticket_messages')) {
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const row = { id: `msg-row-${messages.length + 1}`, created_at: iso(NOW), ...body }
      messages.push(row)
      return json(row)
    }
    const ticketId = eqParam(url, 'ticket_id')
    return json(messages.filter((m) => m.ticket_id === ticketId))
  }

  if (url.includes('/rest/v1/support_tickets')) {
    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const row = {
        id: `ticket-${tickets.length + 1}`, stage: 'new', priority: 'normal', assigned_admin_id: null,
        first_response_at: null, resolved_at: null, created_at: iso(NOW), updated_at: iso(NOW), funnel_id: null,
        ...body,
      }
      tickets.push(row)
      return json(row)
    }
    if (method === 'PATCH') {
      const id = eqParam(url, 'id')
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const row = tickets.find((t) => t.id === id)
      if (row) Object.assign(row, body)
      return json(row ?? null)
    }
    if (method === 'DELETE') {
      const id = eqParam(url, 'id')
      tickets = tickets.filter((t) => t.id !== id)
      return json({})
    }
    const id = eqParam(url, 'id')
    if (id) return json(tickets.find((t) => t.id === id) ?? null)
    const stage = eqParam(url, 'stage')
    const priority = eqParam(url, 'priority')
    const userId = eqParam(url, 'user_id')
    const orClause = orParam(url, 'or')
    const subjectIlike = /subject=ilike\.%([^%]*)%/.exec(url)
    let rows = tickets.slice()
    if (stage) rows = rows.filter((t) => t.stage === stage)
    if (priority) rows = rows.filter((t) => t.priority === priority)
    if (userId) rows = rows.filter((t) => t.user_id === userId)
    if (orClause) {
      const subjM = /subject\.ilike\.%([^%,]*)%/.exec(orClause)
      const idsM = /user_id\.in\.\(([^)]*)\)/.exec(orClause)
      const subjNeedle = (subjM?.[1] || '').toLowerCase()
      const ids = idsM ? idsM[1].split(',') : []
      rows = rows.filter((t) => (subjNeedle && (t.subject || '').toLowerCase().includes(subjNeedle)) || ids.includes(t.user_id))
    } else if (subjectIlike) {
      const needle = subjectIlike[1].toLowerCase()
      rows = rows.filter((t) => (t.subject || '').toLowerCase().includes(needle))
    }
    return json(rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))))
  }

  return json([])
}) as typeof fetch

async function call(handler: Handler, opts: { user?: string; method?: string; body?: any; query?: any }) {
  const token = await createSessionToken(opts.user || MEMBER)
  let status = 0, resBody: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(v: unknown) { resBody = v; return res }, end() { return res } }
  await handler({ headers: { authorization: `Bearer ${token}` }, method: opts.method || 'GET', body: opts.body, query: opts.query || {} } as any, res)
  return { status, body: resBody }
}

function reset() {
  users = {
    [MEMBER]: { name: 'Jamie Coach', email: 'jamie@example.com', status: 'active', role: 'member', membership_tier: 'full', add_ons: {} },
    [OTHER_MEMBER]: { name: 'Other Member', email: 'other@example.com', status: 'active', role: 'member', membership_tier: 'full', add_ons: {} },
    [ADMIN]: { name: 'Ada Min', email: 'ada@example.com', status: 'active', role: 'admin', membership_tier: 'full', add_ons: {} },
  }
  funnels = [{ id: FUNNEL, user_id: MEMBER }]
  tickets = []
  messages = []
  resendSends = []
}

function mkTicket(id: string, o: any = {}) {
  return {
    id, user_id: MEMBER, category: 'technical', subject: `Subject ${id}`, stage: 'new', priority: 'normal',
    funnel_id: null, assigned_admin_id: null, first_response_at: null, resolved_at: null,
    created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), ...o,
  }
}

;(async () => {
  const support = await import('../lib/support')
  const memberTickets: Handler = (await import('../api/support/tickets')).default
  const adminList: Handler = (await import('../api/admin/support/tickets')).default
  const adminDetail: Handler = (await import('../api/admin/support/tickets/[id]')).default
  const adminReply: Handler = (await import('../api/admin/support/tickets/[id]/messages')).default
  const adminStats: Handler = (await import('../api/admin/support/stats')).default

  console.log('\n-- SLA math (lib/support.ts) --')
  ok('not late: responded within 24h', !support.firstResponseLate({ created_at: iso(NOW - 10 * HOUR), first_response_at: iso(NOW - 5 * HOUR), resolved_at: null }, NOW))
  ok('late: responded AFTER 24h', support.firstResponseLate({ created_at: iso(NOW - 30 * HOUR), first_response_at: iso(NOW - 2 * HOUR), resolved_at: null }, NOW))
  ok('late: never responded, >24h elapsed', support.firstResponseLate({ created_at: iso(NOW - 25 * HOUR), first_response_at: null, resolved_at: null }, NOW))
  ok('not late: never responded, <24h elapsed', !support.firstResponseLate({ created_at: iso(NOW - 5 * HOUR), first_response_at: null, resolved_at: null }, NOW))
  ok('resolution late: resolved after 72h', support.resolutionLate({ created_at: iso(NOW - 100 * HOUR), first_response_at: null, resolved_at: iso(NOW - 2 * HOUR) }, NOW))
  ok('resolution not late: resolved within 72h', !support.resolutionLate({ created_at: iso(NOW - 40 * HOUR), first_response_at: null, resolved_at: iso(NOW - 2 * HOUR) }, NOW))
  ok('resolution late: unresolved, >72h elapsed', support.resolutionLate({ created_at: iso(NOW - 80 * HOUR), first_response_at: null, resolved_at: null }, NOW))
  ok('breach counts ONCE even when both targets missed', support.isBreached({ created_at: iso(NOW - 200 * HOUR), first_response_at: null, resolved_at: null }, NOW) === true)
  ok('a ticket resolved late is STILL breached (lifetime, not just open)', support.isBreached({ created_at: iso(NOW - 200 * HOUR), first_response_at: iso(NOW - 190 * HOUR), resolved_at: iso(NOW - 1 * HOUR) }, NOW))
  ok('a ticket resolved on time is not breached', !support.isBreached({ created_at: iso(NOW - 100 * HOUR), first_response_at: iso(NOW - 99 * HOUR), resolved_at: iso(NOW - 90 * HOUR) }, NOW))

  console.log('\n-- stageTimestampUpdates --')
  ok('new -> in_progress stamps first_response_at when unset', !!support.stageTimestampUpdates('in_progress', { stage: 'new', first_response_at: null, resolved_at: null }, iso(NOW)).first_response_at)
  ok('does NOT restamp an existing first_response_at', support.stageTimestampUpdates('waiting_on_member', { stage: 'in_progress', first_response_at: iso(NOW - HOUR), resolved_at: null }, iso(NOW)).first_response_at === undefined)
  ok('-> resolved stamps resolved_at', !!support.stageTimestampUpdates('resolved', { stage: 'in_progress', first_response_at: iso(NOW - HOUR), resolved_at: null }, iso(NOW)).resolved_at)
  ok('moving OUT of resolved clears resolved_at', support.stageTimestampUpdates('in_progress', { stage: 'resolved', first_response_at: iso(NOW - HOUR), resolved_at: iso(NOW - 30 * 60000) }, iso(NOW)).resolved_at === null)
  ok('closed does NOT stamp resolved_at (closing without resolving is not a resolution)', support.stageTimestampUpdates('closed', { stage: 'in_progress', first_response_at: iso(NOW - HOUR), resolved_at: null }, iso(NOW)).resolved_at === undefined)

  console.log('\n-- POST /api/support/tickets --')
  reset()
  const created = await call(memberTickets, { method: 'POST', body: { category: 'technical', subject: 'My builder is broken', message: 'It just spins.' } })
  ok('201', created.status === 201, JSON.stringify(created.body).slice(0, 200))
  ok('ticket has stage new, priority normal', created.body?.ticket?.stage === 'new' && created.body?.ticket?.priority === 'normal')
  ok('stage_label is the member-facing label', created.body?.ticket?.stage_label === 'Received')
  ok('sla block present', created.body?.ticket?.sla?.breached === false)
  ok('the description became the first thread message', messages.length === 1 && messages[0].author_role === 'member' && messages[0].body === 'It just spins.')
  ok('message is attributed to the caller', messages[0].author_user_id === MEMBER)
  ok('exactly one received email, to the member, with SUBJECT', resendSends.length === 1 && resendSends[0].to === 'jamie@example.com' && resendSends[0].template?.variables?.SUBJECT === 'My builder is broken', JSON.stringify(resendSends))

  console.log('\n-- validation --')
  reset()
  ok('missing category 400s', (await call(memberTickets, { method: 'POST', body: { subject: 'x', message: 'y' } })).status === 400)
  ok('bad category 400s', (await call(memberTickets, { method: 'POST', body: { category: 'bogus', subject: 'x', message: 'y' } })).status === 400)
  ok('empty subject 400s', (await call(memberTickets, { method: 'POST', body: { category: 'other', subject: '  ', message: 'y' } })).status === 400)
  ok('empty message 400s', (await call(memberTickets, { method: 'POST', body: { category: 'other', subject: 'x', message: '' } })).status === 400)
  ok('oversized subject 400s', (await call(memberTickets, { method: 'POST', body: { category: 'other', subject: 'x'.repeat(201), message: 'y' } })).status === 400)
  ok('no ticket left behind by a rejected submit', tickets.length === 0)

  console.log('\n-- funnel_id: owned vs unowned --')
  reset()
  const withFunnel = await call(memberTickets, { method: 'POST', body: { category: 'funnel_builder', subject: 'x', message: 'y', funnel_id: FUNNEL } })
  ok('owned funnel_id kept', withFunnel.body?.ticket?.funnel_id === FUNNEL)
  reset()
  const foreignFunnel = await call(memberTickets, { method: 'POST', body: { category: 'funnel_builder', subject: 'x', message: 'y', funnel_id: 'not-mine' } })
  ok('unowned funnel_id silently dropped, not rejected', foreignFunnel.status === 201 && foreignFunnel.body?.ticket?.funnel_id === null)

  console.log('\n-- GET /api/support/tickets (member) --')
  reset()
  tickets = [mkTicket('t1', { user_id: MEMBER }), mkTicket('t2', { user_id: OTHER_MEMBER })]
  const mine = await call(memberTickets, { method: 'GET' })
  ok('only the caller\'s own tickets', mine.body?.tickets?.length === 1 && mine.body.tickets[0].id === 't1')

  console.log('\n-- admin list: filters --')
  reset()
  tickets = [
    mkTicket('a', { subject: 'Billing question', priority: 'low', stage: 'new' }),
    mkTicket('b', { subject: 'App is broken', priority: 'urgent', stage: 'in_progress' }),
    mkTicket('c', { subject: 'Feature idea', priority: 'normal', stage: 'resolved' }),
  ]
  const asMember = await call(adminList, { user: MEMBER })
  ok('a non-admin is blocked', asMember.status === 403)
  const all = await call(adminList, { user: ADMIN })
  ok('admin sees all 3', all.body?.tickets?.length === 3)
  ok('stage_counts present per stage', all.body?.stage_counts?.new === 1 && all.body?.stage_counts?.in_progress === 1 && all.body?.stage_counts?.resolved === 1)
  ok('open_count excludes resolved/closed', all.body?.open_count === 2)
  const byStage = await call(adminList, { user: ADMIN, query: { stage: 'new' } })
  ok('stage filter', byStage.body?.tickets?.length === 1 && byStage.body.tickets[0].id === 'a')
  const byPriority = await call(adminList, { user: ADMIN, query: { priority: 'urgent' } })
  ok('priority filter', byPriority.body?.tickets?.length === 1 && byPriority.body.tickets[0].id === 'b')
  const bySubject = await call(adminList, { user: ADMIN, query: { search: 'billing' } })
  ok('subject search (case-insensitive)', bySubject.body?.tickets?.length === 1 && bySubject.body.tickets[0].id === 'a')
  const byMember = await call(adminList, { user: ADMIN, query: { search: 'Jamie' } })
  ok('member-name search matches even with an unrelated subject', byMember.body?.tickets?.length === 3, JSON.stringify(byMember.body?.tickets?.map((t: any) => t.id)))
  ok('each row carries member info', all.body?.tickets?.every((t: any) => t.member?.name === 'Jamie Coach'))
  const badStage = await call(adminList, { user: ADMIN, query: { stage: 'bogus' } })
  ok('bad stage 400s', badStage.status === 400)

  console.log('\n-- admin detail: GET --')
  reset()
  tickets = [mkTicket('d1')]
  messages = [
    { id: 'm1', ticket_id: 'd1', author_user_id: MEMBER, author_role: 'member', body: 'help', created_at: iso(NOW - 2 * HOUR) },
    { id: 'm2', ticket_id: 'd1', author_user_id: ADMIN, author_role: 'admin', body: 'on it', created_at: iso(NOW - HOUR) },
  ]
  const detail = await call(adminDetail, { user: ADMIN, query: { id: 'd1' } })
  ok('200 with ticket + thread', detail.status === 200 && detail.body?.messages?.length === 2)
  ok('thread is oldest first', detail.body?.messages?.[0]?.id === 'm1' && detail.body?.messages?.[1]?.id === 'm2')
  ok('each message carries its author', detail.body?.messages?.[1]?.author?.name === 'Ada Min')
  ok('a member cannot hit the admin detail route', (await call(adminDetail, { user: MEMBER, query: { id: 'd1' } })).status === 403)
  ok('unknown id 404s', (await call(adminDetail, { user: ADMIN, query: { id: 'nope' } })).status === 404)

  console.log('\n-- admin PATCH: stage change stamps + notifies --')
  reset()
  tickets = [mkTicket('p1', { stage: 'new', first_response_at: null, resolved_at: null })]
  const toInProgress = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p1' }, body: { stage: 'in_progress' } })
  ok('200', toInProgress.status === 200, JSON.stringify(toInProgress.body))
  ok('first_response_at stamped on the first move off new', !!toInProgress.body?.ticket?.first_response_at)
  ok('in_progress is silent — no email', resendSends.length === 0, JSON.stringify(resendSends))
  ok('notified:false echoed', toInProgress.body?.notified === false)

  resendSends = []
  const toWaiting = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p1' }, body: { stage: 'waiting_on_member' } })
  ok('waiting_on_member DOES email, with the member label', resendSends.length === 1 && resendSends[0].template?.variables?.STAGE_LABEL === 'Waiting on you', JSON.stringify(resendSends))
  ok('sent to the member, not the admin', resendSends[0]?.to === 'jamie@example.com')
  ok('notified:true echoed', toWaiting.body?.notified === true)

  resendSends = []
  const toResolved = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p1' }, body: { stage: 'resolved' } })
  ok('resolved stamps resolved_at', !!toResolved.body?.ticket?.resolved_at)
  ok('resolved emails with label "Resolved"', resendSends[0]?.template?.variables?.STAGE_LABEL === 'Resolved')

  resendSends = []
  const reopened = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p1' }, body: { stage: 'in_progress' } })
  ok('reopening clears the stale resolved_at', reopened.body?.ticket?.resolved_at === null, JSON.stringify(reopened.body?.ticket))
  ok('moving to in_progress from resolved is silent again', resendSends.length === 0)

  console.log('\n-- admin PATCH: escalated is silent, closed emails --')
  reset()
  tickets = [mkTicket('p2')]
  await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p2' }, body: { stage: 'escalated' } })
  ok('escalated sends no email', resendSends.length === 0)
  resendSends = []
  await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p2' }, body: { stage: 'closed' } })
  ok('closed DOES email', resendSends.length === 1 && resendSends[0].template?.variables?.STAGE_LABEL === 'Closed')
  ok('closed does NOT stamp resolved_at (closed without resolving)', !tickets.find((t) => t.id === 'p2')?.resolved_at)

  console.log('\n-- admin PATCH: re-PATCHing the SAME stage does not re-notify or re-stamp --')
  reset()
  tickets = [mkTicket('p3', { stage: 'waiting_on_member', first_response_at: iso(NOW - HOUR) })]
  const firstStamp = tickets[0].first_response_at
  await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p3' }, body: { stage: 'waiting_on_member' } })
  ok('no duplicate email on a no-op stage patch', resendSends.length === 0)
  ok('first_response_at unchanged', tickets[0].first_response_at === firstStamp)

  console.log('\n-- admin PATCH: priority + assignment --')
  reset()
  tickets = [mkTicket('p4')]
  const priorityPatch = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p4' }, body: { priority: 'urgent' } })
  ok('priority updates without touching stage/SLA', priorityPatch.body?.ticket?.priority === 'urgent' && priorityPatch.body?.ticket?.stage === 'new')
  const assignPatch = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p4' }, body: { assigned_admin_id: ADMIN } })
  ok('assigning to a real admin succeeds', assignPatch.body?.ticket?.assigned_admin_id === ADMIN)
  ok('assigned_admin resolved on the response', assignPatch.body?.ticket?.assigned_admin?.name === 'Ada Min')
  const assignMember = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p4' }, body: { assigned_admin_id: MEMBER } })
  ok('assigning to a non-admin is rejected', assignMember.status === 400, JSON.stringify(assignMember.body))
  const badField = await call(adminDetail, { user: ADMIN, method: 'PATCH', query: { id: 'p4' }, body: { subject: 'nope' } })
  ok('unknown field 400s', badField.status === 400)

  console.log('\n-- admin reply: POST messages --')
  reset()
  tickets = [mkTicket('r1', { first_response_at: null })]
  const reply1 = await call(adminReply, { user: ADMIN, method: 'POST', query: { id: 'r1' }, body: { body: 'Looking into it now.' } })
  ok('201', reply1.status === 201, JSON.stringify(reply1.body))
  ok('message recorded with author_role admin', messages[0]?.author_role === 'admin' && messages[0]?.body === 'Looking into it now.')
  ok('first_response_at stamped by the reply itself', !!tickets[0].first_response_at)
  ok('first_response_stamped:true on first reply', reply1.body?.first_response_stamped === true)
  ok('a reply does NOT change stage', tickets[0].stage === 'new')
  ok('a reply sends NO email (stage-only notification)', resendSends.length === 0)
  const firstStampValue = tickets[0].first_response_at
  const reply2 = await call(adminReply, { user: ADMIN, method: 'POST', query: { id: 'r1' }, body: { body: 'Following up.' } })
  ok('a second reply does not restamp first_response_at', tickets[0].first_response_at === firstStampValue)
  ok('first_response_stamped:false on the second reply', reply2.body?.first_response_stamped === false)
  ok('a member cannot post an admin reply', (await call(adminReply, { user: MEMBER, method: 'POST', query: { id: 'r1' }, body: { body: 'x' } })).status === 403)
  ok('empty body 400s', (await call(adminReply, { user: ADMIN, method: 'POST', query: { id: 'r1' }, body: { body: '' } })).status === 400)

  console.log('\n-- admin stats --')
  reset()
  tickets = [
    mkTicket('s1', { stage: 'new', created_at: iso(NOW - 30 * HOUR), first_response_at: null, resolved_at: null }), // breached: no first response after 30h
    mkTicket('s2', { stage: 'in_progress', created_at: iso(NOW - 10 * HOUR), first_response_at: iso(NOW - 8 * HOUR), resolved_at: null }), // within first-response SLA, unresolved but young
    mkTicket('s3', { stage: 'resolved', created_at: iso(NOW - 100 * HOUR), first_response_at: iso(NOW - 99 * HOUR), resolved_at: iso(NOW - 90 * HOUR) }), // resolved on time
    mkTicket('s4', { stage: 'resolved', created_at: iso(NOW - 200 * HOUR), first_response_at: iso(NOW - 190 * HOUR), resolved_at: iso(NOW - HOUR) }), // resolved LATE -> still breached
  ]
  const stats = await call(adminStats, { user: ADMIN })
  ok('200', stats.status === 200, JSON.stringify(stats.body).slice(0, 300))
  ok('open_tickets excludes resolved/closed', stats.body?.stats?.open_tickets === 2, JSON.stringify(stats.body?.stats))
  ok('awaiting_first_reply counts open tickets with no first_response_at', stats.body?.stats?.awaiting_first_reply === 1)
  ok('sla_breaches = 2 (s1 unanswered, s4 resolved late) -- lifetime, not just open', stats.body?.stats?.sla_breaches === 2, JSON.stringify(stats.body?.stats))
  ok('within_sla_pct = 50% (2 of 4 breached)', stats.body?.stats?.within_sla_pct === 50, stats.body?.stats?.within_sla_pct)
  ok('targets travel with the response', stats.body?.targets?.first_response_hours === 24 && stats.body?.targets?.resolution_hours === 72)
  ok('volume series has exactly 14 entries', stats.body?.volume?.length === 14, stats.body?.volume?.length)
  ok('volume entries are date+count', typeof stats.body?.volume?.[0]?.date === 'string' && typeof stats.body?.volume?.[0]?.count === 'number')
  const statsAsMember = await call(adminStats, { user: MEMBER })
  ok('a non-admin is blocked from stats', statsAsMember.status === 403)

  console.log('\n-- zero-tickets empty state --')
  reset()
  const emptyStats = await call(adminStats, { user: ADMIN })
  ok('within_sla_pct is null with no tickets, not NaN/divide-by-zero', emptyStats.body?.stats?.within_sla_pct === null, JSON.stringify(emptyStats.body?.stats))
  ok('all 14 volume days present at zero', emptyStats.body?.volume?.every((v: any) => v.count === 0))
  const emptyList = await call(adminList, { user: ADMIN })
  ok('empty ticket list, all stage_counts zero', emptyList.body?.tickets?.length === 0 && Object.values(emptyList.body?.stage_counts || {}).every((n) => n === 0))

  console.log('\n-- method guards --')
  reset()
  ok('DELETE on member tickets 405s', (await call(memberTickets, { method: 'DELETE' })).status === 405)
  ok('POST on admin list 405s', (await call(adminList, { user: ADMIN, method: 'POST' })).status === 405)
  ok('DELETE on admin detail 405s', (await call(adminDetail, { user: ADMIN, method: 'DELETE', query: { id: 'x' } })).status === 405)
  ok('GET on admin reply 405s', (await call(adminReply, { user: ADMIN, method: 'GET', query: { id: 'x' } })).status === 405)
  ok('POST on admin stats 405s', (await call(adminStats, { user: ADMIN, method: 'POST' })).status === 405)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
  globalThis.fetch = realFetch
})()
