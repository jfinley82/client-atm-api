// Phrasing sanitizers. The style guide bans em-dash clause splits (and spaced
// "word - word" splitters), but the model occasionally emits them anyway despite
// STYLE_GUIDELINES being injected — so we enforce it in code. Phrasing-only: these
// never change meaning or which fields exist; they only normalize the connective
// punctuation. Compounds and ranges (well-known, coffee-budget, 3-4, 10-12) use an
// unspaced hyphen and are left untouched.

export function stripClauseDashes(s: string): string {
  if (typeof s !== 'string') return s
  return s
    .replace(/\s*[—–]\s*/g, ', ') // em/en dash clause splitter -> comma
    .replace(/(\S) - (\S)/g, '$1, $2') // spaced-hyphen splitter -> comma
    .replace(/,\s*([.,;:!?])/g, '$1') // no comma before end punctuation
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Deep-walk a value, applying stripClauseDashes to every string. Safe on any
// audience/results object — a clause em-dash never belongs in a content field.
export function sanitizePhrasingDeep<T>(v: T): T {
  if (typeof v === 'string') return stripClauseDashes(v) as unknown as T
  if (Array.isArray(v)) return v.map(sanitizePhrasingDeep) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = sanitizePhrasingDeep(val)
    return out as T
  }
  return v
}
