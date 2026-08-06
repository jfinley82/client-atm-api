process.env.SUPABASE_URL = 'https://stub.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key'
process.env.JWT_SECRET = 'stub-secret'

import { createSessionToken } from '../lib/auth'
import {
  DIRECT_UPLOAD_MAX_BYTES,
  PLATFORM_BODY_LIMIT_BYTES,
  UPLOAD_TOO_LARGE_STATUS,
  readBoundedBody,
} from '../lib/rawBody'
import { SIGNED_UPLOAD_MAX_BYTES } from '../lib/uploadUrl'

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

const USER = 'user-1'
// Admin so the same session satisfies requireAdmin on the hub cover endpoint.
// These assertions are about size, not authorization.
const ADMIN = USER

// Filled in by the sweep below and asserted against the endpoint table, so a
// new raw-body endpoint cannot be added without being checked for agreement.
let rawBodyEndpointCount = 0

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = decodeURIComponent(String(typeof input === 'string' ? input : input.url))
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.includes('/rest/v1/users')) {
    return json({ id: USER, status: 'active', role: 'admin', membership_tier: 'full' })
  }
  // the hub cover endpoint checks the listing exists before reading the body
  if (url.includes('/rest/v1/hub_listings')) return json({ id: 'listing-1' })
  // storage: POST /object/upload/sign/<bucket>/<path> mints the credential
  if (url.includes('/storage/v1/object/upload/sign/')) {
    const path = url.split('/storage/v1/object/upload/sign/')[1].split('?')[0]
    return json({ url: `/object/upload/sign/${path}?token=stub-token` })
  }
  return json({})
}) as typeof fetch

;(async () => {
  console.log('\n-- the platform ceiling is the thing every direct limit must sit under --')
  // The whole point of the change. A MAX_BYTES above Vercel's edge cap is
  // unreachable code pretending to be a limit: the request never reaches the
  // function, so the handler's 413 is never written and the client sees a
  // transport failure with no body. Assert the RELATIONSHIP, not the number —
  // if someone raises a direct limit past the ceiling, this fails.
  {
    ok(
      'the direct-upload limit is below the platform body cap',
      DIRECT_UPLOAD_MAX_BYTES < PLATFORM_BODY_LIMIT_BYTES,
      `${DIRECT_UPLOAD_MAX_BYTES} vs ${PLATFORM_BODY_LIMIT_BYTES}`
    )

    const { readFileSync, readdirSync } = await import('fs')
    const { join } = await import('path')
    // __dirname is the esbuild bundle's directory under node_modules, not tests/.
    // scripts/run-tests.mjs runs from the repo root, so anchor to cwd.
    const repoRoot = process.cwd()

    // Sweep every endpoint that turns the body parser off and declares its own
    // byte cap. Any literal cap is a regression: it cannot be checked against
    // the ceiling, which is exactly how five of these drifted above it.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
      )

    const offenders: string[] = []
    for (const file of walk(join(repoRoot, 'api'))) {
      const src = readFileSync(file, 'utf8')
      if (!/bodyParser:\s*false/.test(src)) continue
      // Webhooks (stripe, resend, zoom) also read raw bodies, but for signature
      // verification rather than an upload — no cap, nothing to agree about.
      if (/from '(\.\.\/)+lib\/rawBody'/.test(src)) rawBodyEndpointCount++
      // A literal byte arithmetic cap, e.g. `10 * 1024 * 1024`.
      const literal = /const\s+MAX_\w*BYTES\s*=\s*\d+\s*\*/.exec(src)
      if (literal) offenders.push(`${file.split('/api/')[1]}: ${literal[0]}`)
    }
    ok(
      'no raw-body endpoint declares its own literal byte cap',
      offenders.length === 0,
      offenders.join('\n      ')
    )
  }

  console.log('\n-- readBoundedBody drains rather than destroying --')
  {
    const { Readable } = await import('stream')

    async function read(totalBytes: number, max = DIRECT_UPLOAD_MAX_BYTES) {
      const chunk = Buffer.alloc(256 * 1024, 1)
      const chunks: Buffer[] = []
      for (let sent = 0; sent < totalBytes; sent += chunk.length) {
        chunks.push(chunk.subarray(0, Math.min(chunk.length, totalBytes - sent)))
      }
      const req: any = Readable.from(chunks)
      let err: Error | null = null
      let buf: Buffer | null = null
      try {
        buf = await readBoundedBody(req, max)
      } catch (e) {
        err = e as Error
      }
      return { err, buf, drained: req.readableEnded === true }
    }

    const under = await read(512 * 1024)
    ok('a body under the limit resolves whole', !under.err && under.buf?.length === 512 * 1024, String(under.err))

    const over = await read(DIRECT_UPLOAD_MAX_BYTES + 512 * 1024)
    ok('a body over the limit rejects with file_too_large', over.err?.message === 'file_too_large', String(over.err))
    // Node's Readable auto-destroys on completion, so "was destroy called" says
    // nothing. readableEnded is true only when the stream reached 'end'
    // naturally rather than being torn down mid-flight — which is what
    // req.destroy() used to do, taking the response with it.
    ok('and the stream still drained to end', over.drained === true, 'torn down mid-stream — the response dies with it')

    const exact = await read(DIRECT_UPLOAD_MAX_BYTES)
    ok('a body exactly at the limit is accepted', !exact.err && exact.buf?.length === DIRECT_UPLOAD_MAX_BYTES, String(exact.err))
  }

  console.log('\n-- the direct uploaders report the limit they actually enforce --')
  // The message and the constant have to agree. They disagreed for as long as
  // MAX_BYTES was unreachable: members were told 10MB by a handler that could
  // never see more than ~4.5MB.
  {
    const { Readable } = await import('stream')

    // Literal specifiers only — esbuild bundles those, but a dynamic
    // import(variable) is left alone and resolves against the bundle's own
    // directory under node_modules at runtime.
    const forumUpload: Handler = (await import('../api/forum/upload-image')).default
    const slidesUpload: Handler = (await import('../api/slides/upload-image')).default

    async function upload(handler: Handler, totalBytes: number, query: any = {}) {
      const chunk = Buffer.alloc(512 * 1024, 1)
      const chunks: Buffer[] = []
      for (let sent = 0; sent < totalBytes; sent += chunk.length) {
        chunks.push(chunk.subarray(0, Math.min(chunk.length, totalBytes - sent)))
      }
      const req: any = Readable.from(chunks)
      req.method = 'POST'
      req.headers = { 'content-type': 'image/png', authorization: `Bearer ${await createSessionToken(USER)}` }
      req.query = query
      let status = 0
      let body: any = null
      const res: any = {
        setHeader() {},
        status(c: number) {
          status = c
          return res
        },
        json(v: unknown) {
          body = v
          return res
        },
        end() {
          return res
        },
      }
      await handler(req, res)
      return { status, body, drained: req.readableEnded === true }
    }

    const forum = await upload(forumUpload, DIRECT_UPLOAD_MAX_BYTES + 256 * 1024)
    ok('forum: oversized is 413', forum.status === 413, `${forum.status}`)
    ok('forum: the message names 4MB, the limit it enforces', forum.body?.error === 'Image must be 4MB or smaller', JSON.stringify(forum.body))
    ok('forum: the stream drained', forum.drained === true)

    const slides = await upload(slidesUpload, DIRECT_UPLOAD_MAX_BYTES + 256 * 1024, { card_id: 'card-1' })
    ok('slides: oversized is 413', slides.status === 413, `${slides.status}`)
    ok('slides: same message from the template it was copied from', slides.body?.error === 'Image must be 4MB or smaller', JSON.stringify(slides.body))
  }

  console.log('\n-- every raw-body endpoint answers the same condition the same way --')
  // Assert the endpoints against EACH OTHER, not against a constant. They share
  // one condition and used to disagree about it: forum and slides said 413,
  // avatar, guide, hub cover, transcribe and pdf/render said 400. Every message
  // was correct and readable, so nothing was member-facing — it bites the first
  // time a frontend writes `if (res.status === 413)` and gets it right on two
  // endpoints out of seven.
  //
  // Comparing each to UPLOAD_TOO_LARGE_STATUS alone would not catch the failure
  // that matters, which is two endpoints differing. So collect them all and
  // check the SET has one member.
  {
    const { Readable } = await import('stream')

    const avatar: Handler = (await import('../api/auth/upload-avatar')).default
    const cover: Handler = (await import('../api/hub/admin/listings/[id]/cover')).default
    const guide: Handler = (await import('../api/guide/publish')).default
    const transcribe: Handler = (await import('../api/transcribe')).default
    const render: Handler = (await import('../api/pdf/render')).default
    const forumUpload: Handler = (await import('../api/forum/upload-image')).default
    const slidesUpload: Handler = (await import('../api/slides/upload-image')).default

    process.env.GROQ_API_KEY = 'stub-groq-key'

    // Every endpoint that reads a raw body under a cap. If one is added without
    // a row here the count assertion below fails, so the table cannot quietly
    // fall behind the api/ directory.
    const endpoints: Array<{ name: string; handler: Handler; contentType: string; query?: any }> = [
      { name: 'forum/upload-image', handler: forumUpload, contentType: 'image/png' },
      { name: 'slides/upload-image', handler: slidesUpload, contentType: 'image/png', query: { card_id: 'card-1' } },
      { name: 'auth/upload-avatar', handler: avatar, contentType: 'image/png' },
      { name: 'hub/listings/[id]/cover', handler: cover, contentType: 'image/png', query: { id: 'listing-1' } },
      { name: 'guide/publish', handler: guide, contentType: 'application/pdf', query: { card_id: 'card-1' } },
      { name: 'transcribe', handler: transcribe, contentType: 'audio/webm' },
      { name: 'pdf/render', handler: render, contentType: 'application/json' },
    ]

    const statuses = new Map<string, number>()
    for (const ep of endpoints) {
      const chunk = Buffer.alloc(512 * 1024, 1)
      const total = DIRECT_UPLOAD_MAX_BYTES + 256 * 1024
      const chunks: Buffer[] = []
      for (let sent = 0; sent < total; sent += chunk.length) {
        chunks.push(chunk.subarray(0, Math.min(chunk.length, total - sent)))
      }
      const req: any = Readable.from(chunks)
      req.method = 'POST'
      req.headers = { 'content-type': ep.contentType, authorization: `Bearer ${await createSessionToken(ADMIN)}` }
      req.query = ep.query || {}
      let status = 0
      let body: any = null
      const res: any = {
        setHeader() {},
        status(c: number) {
          status = c
          return res
        },
        json(v: unknown) {
          body = v
          return res
        },
        send() {
          return res
        },
        end() {
          return res
        },
      }
      await ep.handler(req, res)
      statuses.set(ep.name, status)
      ok(`${ep.name}: refuses an oversized body with a message`, typeof body?.error === 'string' && status !== 0, `${status} ${JSON.stringify(body)}`)
    }

    const distinct = new Set(statuses.values())
    ok(
      'all seven agree on ONE status for too-large',
      distinct.size === 1,
      [...statuses].map(([k, v]) => `${k}=${v}`).join('  ')
    )
    ok(
      'and it is the status lib/rawBody.ts declares',
      distinct.size === 1 && [...distinct][0] === UPLOAD_TOO_LARGE_STATUS,
      `${[...distinct]} vs ${UPLOAD_TOO_LARGE_STATUS}`
    )
    ok('the table covers every raw-body endpoint in api/', statuses.size === rawBodyEndpointCount, `${statuses.size} tested vs ${rawBodyEndpointCount} found`)
  }

  console.log('\n-- signed upload URLs: the path is ours, the ceiling is not the platform’s --')
  {
    const forumSign: Handler = (await import('../api/forum/upload-url')).default
    const slidesSign: Handler = (await import('../api/slides/upload-url')).default

    async function sign(handler: Handler, body: any, query: any = {}) {
      const req: any = {
        method: 'POST',
        headers: { authorization: `Bearer ${await createSessionToken(USER)}` },
        query,
        body,
      }
      let status = 0
      let out: any = null
      const res: any = {
        setHeader() {},
        status(c: number) {
          status = c
          return res
        },
        json(v: unknown) {
          out = v
          return res
        },
        end() {
          return res
        },
      }
      await handler(req, res)
      return { status, body: out }
    }

    const good = await sign(forumSign, { content_type: 'image/png', size: 8 * 1024 * 1024 })
    ok('an 8MB image is signed, well past what a function could ever receive', good.status === 200, `${good.status} ${JSON.stringify(good.body)}`)
    ok('the limit reported is the signed one, not the direct one', good.body?.maxBytes === SIGNED_UPLOAD_MAX_BYTES, JSON.stringify(good.body?.maxBytes))
    ok('the path is pinned to the session user', typeof good.body?.path === 'string' && good.body.path.startsWith(`${USER}/`), good.body?.path)
    ok('and carries the extension for the declared type', /\.png$/.test(good.body?.path || ''), good.body?.path)
    ok('an upload URL comes back', typeof good.body?.uploadUrl === 'string' && good.body.uploadUrl.includes('token='), good.body?.uploadUrl)

    const tooBig = await sign(forumSign, { content_type: 'image/png', size: SIGNED_UPLOAD_MAX_BYTES + 1 })
    ok('a declared size over the signed limit is refused up front', tooBig.status === 413, `${tooBig.status}`)

    const badType = await sign(forumSign, { content_type: 'application/pdf', size: 2048 })
    ok('a non-image type is 415 before any credential is minted', badType.status === 415, `${badType.status}`)

    // size is REQUIRED, and this is why: storage answers an oversize PUT with
    // HTTP 400 carrying "statusCode":"413" in the body, so a refusal that
    // happens there cannot be detected by status. Declaring the size keeps the
    // only member-facing case on our side of the wire, where it is a real 413.
    const noSize = await sign(forumSign, { content_type: 'image/png' })
    ok('a signing request without a size is refused', noSize.status === 400 && noSize.body?.error === 'size required', `${noSize.status} ${JSON.stringify(noSize.body)}`)

    ok(
      'the signed oversize refusal uses the same status as the direct endpoints',
      tooBig.status === UPLOAD_TOO_LARGE_STATUS,
      `${tooBig.status} vs ${UPLOAD_TOO_LARGE_STATUS}`
    )

    const slidesOk = await sign(slidesSign, { content_type: 'image/webp', size: 2048 }, { card_id: 'card-1' })
    ok('slides: the path nests the card under the user', slidesOk.body?.path?.startsWith(`${USER}/card-1/`), slidesOk.body?.path)

    // card_id reaches the storage path and comes from the request, unlike the
    // user id. Without the segment guard it could climb out of the member's
    // own prefix.
    const traversal = await sign(slidesSign, { content_type: 'image/png', size: 2048 }, { card_id: '../other-user' })
    ok('slides: a traversing card_id is refused, not interpolated', traversal.status === 400, `${traversal.status} ${JSON.stringify(traversal.body)}`)

    const dotted = await sign(slidesSign, { content_type: 'image/png', size: 2048 }, { card_id: 'a/b' })
    ok('slides: a card_id with a separator is refused too', dotted.status === 400, `${dotted.status}`)

    const noAuthReq: any = { method: 'GET', headers: {}, query: {}, body: {} }
    let methodStatus = 0
    const methodRes: any = {
      setHeader() {},
      status(c: number) {
        methodStatus = c
        return methodRes
      },
      json() {
        return methodRes
      },
      end() {
        return methodRes
      },
    }
    await forumSign(noAuthReq, methodRes)
    ok('GET on the signing endpoint 405s', methodStatus === 405, `${methodStatus}`)
  }

  console.log('\n-- the migration and the constant have to agree --')
  // The constant is what members are told; the bucket is what actually refuses
  // them. If 087 says one number and lib/uploadUrl.ts says another, the app
  // promises a size storage will reject.
  {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '087_storage_upload_limits.sql'), 'utf8')
    const m = /file_size_limit\s*=\s*(\d+)/.exec(sql)
    ok(
      'migration 087 sets the bucket limit to SIGNED_UPLOAD_MAX_BYTES',
      !!m && Number(m[1]) === SIGNED_UPLOAD_MAX_BYTES,
      `${m?.[1]} vs ${SIGNED_UPLOAD_MAX_BYTES}`
    )
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      ok(`migration 087 allows ${t}`, sql.includes(`'${t}'`))
    }
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
