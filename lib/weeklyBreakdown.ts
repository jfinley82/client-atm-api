import type { WeeklyBreakdownEntry } from './programAnalysis'

// ONE OWNER for "is this a usable weekly_breakdown entry".
//
// It was a private function in api/toolkits/program/confirm.ts, which is the
// only place that had ever needed it. Client Programs needs the same answer
// when it turns a snapshot into a client's plan, and a second copy would be a
// second definition of a valid program — the two would agree until one was
// relaxed.
//
// A MODULE WITH NO RUNTIME IMPORTS, deliberately. The type lives in
// lib/programAnalysis.ts, which constructs an Anthropic client at module scope;
// importing the value from there would drag the SDK into every route that plans
// items. `import type` is erased at compile time, so this file depends on
// nothing at runtime — the same reason lib/audienceDisplay.ts was lifted out of
// api/tools/chat.ts.

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * A breakdown entry we can build a client's week from.
 *
 * `client_milestone` may be an EMPTY string and still be valid — §6.1 says a
 * blank milestone produces no milestone row rather than rejecting the program.
 * `phase_name` may not: it labels the phase rail, and a blank one produces an
 * unnamed segment the client cannot read.
 */
export function isValidWeeklyEntry(v: unknown): v is WeeklyBreakdownEntry {
  if (!v || typeof v !== 'object') return false
  const w = v as Record<string, unknown>
  return (
    typeof w.week === 'number' &&
    isNonEmptyString(w.phase_name) &&
    typeof w.session_focus === 'string' &&
    typeof w.client_milestone === 'string'
  )
}
