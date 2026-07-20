// Shared JSON-extraction helper for the one-shot AI analysis generators
// (matcherAnalysis, transformationAnalysis, frameworkAnalysis). Previously
// each file duplicated an identical bare `JSON.parse`, so a truncated model
// response (max_tokens cut off mid-string) surfaced as an unhandled
// SyntaxError that bubbled up as a generic 500 with no indication of the
// real cause — confirmed in production for matcher/analyze on 2026-07-08.
//
// GenerationParseError carries the raw (fence-stripped) text alongside the
// parse failure so callers can log it, and lets endpoint handlers
// distinguish "the model's output didn't parse" (almost always truncation)
// from any other unexpected error, and return a specific, diagnosable error
// code instead of a generic 500.
export class GenerationParseError extends Error {
  rawText: string
  constructor(message: string, rawText: string) {
    super(message)
    this.name = 'GenerationParseError'
    this.rawText = rawText
  }
}

// Escapes raw control characters (newline, tab, etc.) that appear INSIDE JSON
// string literals, leaving structural whitespace between tokens untouched.
// Model output routinely puts literal line breaks inside long string values
// (slide scripts, email bodies, workbook prose), which strict JSON.parse
// rejects ("Bad control character in string literal") even though nothing was
// truncated. Walks the text tracking string/escape state so only in-string
// control chars are escaped.
function escapeControlCharsInStrings(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      out += ch
      inString = false
      continue
    }
    const code = input.charCodeAt(i)
    if (code < 0x20) {
      if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else if (ch === '\b') out += '\\b'
      else if (ch === '\f') out += '\\f'
      else out += '\\u' + code.toString(16).padStart(4, '0')
      continue
    }
    out += ch
  }
  return out
}

export function extractJson(text: string): any {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    // Fast path — well-formed JSON parses directly, so existing callers are
    // unaffected.
    return JSON.parse(cleaned)
  } catch (firstErr) {
    // Retry after escaping raw control chars inside string literals. This is
    // NOT truncation — it repairs valid-but-strict-illegal model prose. A
    // genuinely truncated response (unterminated string) still fails here and
    // falls through to GenerationParseError.
    try {
      return JSON.parse(escapeControlCharsInStrings(cleaned))
    } catch {
      throw new GenerationParseError(
        `Failed to parse model output as JSON: ${(firstErr as Error).message}`,
        cleaned
      )
    }
  }
}
