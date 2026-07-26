import fs from 'fs'
import path from 'path'
import opentype from 'opentype.js'

// Static print assets live in api/pdf/assets/ and are bundled into the document
// function via `includeFiles` in vercel.json. Everything is read once and cached
// for the lifetime of the warm lambda.
//
// The three cover JPEGs are photographic chalkboard textures at 1632x2176, q88
// (~0.5-0.8MB each) — small enough to inline as data: URLs under the render
// engine's ~6MB body cap (the engine aborts non-data: requests, so a hosted URL
// would not load). MTM_Chalk.ttf is the brush font that matches the painted
// lettering; it is both parsed for advance-width measurement (font fit) and
// inlined as a @font-face data: URL so the cover renders in the same font.

export type DocType = 'framework' | 'guide' | 'script'

const COVER_FILE: Record<DocType, string> = {
  framework: 'cover_framework.jpg',
  guide: 'cover_guide.jpg',
  script: 'cover_script.jpg',
}

const FONT_FILE = 'MTM_Chalk.ttf'

// Resolve an asset path. process.cwd() is the deployment root on Vercel, where
// includeFiles preserves the api/pdf/assets/ tree.
function assetPath(file: string): string {
  return path.join(process.cwd(), 'api', 'pdf', 'assets', file)
}

const bufCache = new Map<string, Buffer>()
function readAsset(file: string): Buffer {
  const cached = bufCache.get(file)
  if (cached) return cached
  const buf = fs.readFileSync(assetPath(file))
  bufCache.set(file, buf)
  return buf
}

const b64Cache = new Map<string, string>()
function base64(file: string): string {
  const cached = b64Cache.get(file)
  if (cached) return cached
  const b = readAsset(file).toString('base64')
  b64Cache.set(file, b)
  return b
}

// The cover image as a ready-to-embed data: URL for the given document type.
export function coverDataUrl(doc: DocType): string {
  return `data:image/jpeg;base64,${base64(COVER_FILE[doc])}`
}

// The brush font as a ready-to-embed data: URL for the @font-face src.
export function fontDataUrl(): string {
  return `data:font/ttf;base64,${base64(FONT_FILE)}`
}

// The parsed font, for advance-width measurement in the fit step.
let parsedFont: opentype.Font | null = null
export function chalkFont(): opentype.Font {
  if (parsedFont) return parsedFont
  const buf = readAsset(FONT_FILE)
  // opentype.parse takes an ArrayBuffer; slice to this Buffer's exact view so a
  // pooled Node Buffer never hands over neighbouring bytes.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  parsedFont = opentype.parse(ab)
  return parsedFont
}
