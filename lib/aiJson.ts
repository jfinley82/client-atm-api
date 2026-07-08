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

export function extractJson(text: string): any {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch (err) {
    throw new GenerationParseError(
      `Failed to parse model output as JSON: ${(err as Error).message}`,
      cleaned
    )
  }
}
