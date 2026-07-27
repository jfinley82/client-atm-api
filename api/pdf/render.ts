import type { VercelRequest, VercelResponse } from '@vercel/node'
import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'

// @sparticuz/chromium is pinned to 133.0.0 — the last CommonJS release (137+ is
// ESM-only) — with its matching puppeteer-core (Chrome 133). Both are CJS, so
// these plain static imports compile to require(), and Vercel's dependency tracer
// follows the require graph and bundles chromium's runtime deps (tar-fs and the
// rest) into the function. The Chrome version is irrelevant for document PDFs.

// POST /api/pdf/render — server-side PDF engine. Turns a COMPLETE, print-ready
// HTML document (supplied by the frontend, with its own <style>, @page rules, and
// all images/fonts inlined as data: URLs) into a real vector, selectable-text PDF
// using headless Chromium. Replaces the client-side screenshot approach for the
// document PDFs (framework, guide, script). Slides are NOT affected.
//
// The guide flow calls this to get bytes, then POSTs those bytes to the existing
// /api/guide/publish to host them — that endpoint is untouched.
//
// This endpoint RENDERS attacker-influenceable HTML, so it is locked down: no
// script execution, and every network request that is not a data: URL is aborted
// (no SSRF, no exfiltration) — which is why the frontend must inline assets.
//
// bodyParser is disabled so the raw body is read under a hard size cap (a
// print-ready doc with inlined fonts/images can be large); memory + maxDuration
// for this chromium function are set in vercel.json.
export const config = { api: { bodyParser: false } }

// Hard cap on the HTML document. Note Vercel's own request-body ceiling (~4.5MB)
// applies first; this is the app-level guard and a clean 400.
const MAX_HTML_BYTES = 6 * 1024 * 1024

// Settle window after `load` so inlined data: URL webfonts finish decoding and
// applying before page.pdf() captures. Inlined fonts decode in well under this;
// generous enough to cover a cold, CPU-throttled lambda without meaningfully
// affecting the (60s) budget.
const FONT_SETTLE_MS = 800

// Read the request body into a Buffer, aborting once the cap is exceeded so an
// oversized payload can't be accumulated into memory unbounded. Mirrors the
// bounded-read pattern in api/guide/publish.ts.
function readBoundedBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_HTML_BYTES) {
        req.destroy()
        reject(new Error('too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Remove <script> tags. Script execution is already disabled on the page, so this
// is defense in depth — the document should be pure markup + CSS + data: URLs.
function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
}

// A safe download filename: strip anything that could break the header (no CRLF,
// quotes, or path separators), bound the length, and fall back to "document".
function sanitizeFilename(name: unknown): string {
  const base = typeof name === 'string' ? name.trim() : ''
  const cleaned = base
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return cleaned.length > 0 ? cleaned : 'document'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  // Read + parse the JSON body under the size cap.
  let body: Record<string, unknown>
  try {
    const raw = await readBoundedBody(req)
    body = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>
  } catch (err) {
    if (err instanceof Error && err.message === 'too_large') {
      return res.status(400).json({ error: 'html too large (max 6MB)' })
    }
    return res.status(400).json({ error: 'Invalid JSON body' })
  }

  const html = typeof body.html === 'string' ? body.html : ''
  if (html.trim().length === 0) {
    return res.status(400).json({ error: 'html required' })
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return res.status(400).json({ error: 'html too large (max 6MB)' })
  }

  const format: 'Letter' | 'A4' = body.format === 'A4' ? 'A4' : 'Letter'
  const filename = sanitizeFilename(body.filename)
  const safeHtml = stripScripts(html)

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null
  try {
    // Document PDFs need no WebGL, so skip the graphics stack (faster cold start,
    // avoids extracting swiftshader to /tmp).
    chromium.setGraphicsMode = false
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    })
    const page = await browser.newPage()

    // Lock the page down: no scripts, and no network beyond inlined data: URLs.
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      if (request.url().startsWith('data:')) request.continue()
      else request.abort()
    })

    await page.emulateMediaType('print')
    await page.setContent(safeHtml, { waitUntil: 'load' })

    // The document's fonts are inlined as data: URLs. Chromium can fire `load`
    // before a webfont has decoded and applied, and with JavaScript disabled we
    // cannot await document.fonts.ready. Without this settle, text set in a
    // custom @font-face renders blank during the face's block period (system-font
    // text is unaffected — which is why only the branded cover slots went blank).
    // The face is also declared font-display:swap as a backstop so any capture
    // that still races shows the fallback family rather than nothing.
    await new Promise((resolve) => setTimeout(resolve, FONT_SETTLE_MS))

    // Let the document's own @page size + margins drive layout.
    const pdf = await page.pdf({
      format,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })

    const bytes = Buffer.from(pdf)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`)
    res.setHeader('Content-Length', String(bytes.length))
    return res.status(200).send(bytes)
  } catch (err) {
    console.error('[pdf/render] render failed', err)
    return res.status(500).json({ error: 'PDF render failed' })
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        /* best-effort close */
      }
    }
  }
}
