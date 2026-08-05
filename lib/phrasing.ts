// Phrasing sanitizers. The style guide bans em-dash clause splits (and spaced
// "word - word" splitters), but the model occasionally emits them anyway despite
// STYLE_GUIDELINES being injected — so we enforce it in code. Phrasing-only: these
// never change meaning or which fields exist; they only normalize the connective
// punctuation. Compounds and ranges (well-known, coffee-budget, 3-4, 10-12) use an
// unspaced hyphen and are left untouched.
//
// NEWLINES ARE CONTENT HERE, NOT WHITESPACE. Every rule below is deliberately
// blind to \n. This module runs on the WRITE path (runUnit's
// sanitizePhrasingDeep(built)) as well as on read, so anything it flattens is
// flattened in the stored row, permanently, for every asset the generator
// produces. Two rules used to reach across newlines with \s, and between them
// they turned every multi-paragraph body into one block:
//
//   /\s{2,}/g -> ' '        collapsed "\n\n" (two whitespace chars) into a space
//   /\s*[—–]\s*/g -> ', '   turned "line\n\n— point" into "line, point"
//
// That is why a prompt could ask four separate times for blank-line separated
// copy and still store one block: the paragraphs were generated and then
// removed after the fact. If you add a rule, match horizontal whitespace with
// [^\S\n], never \s.

// Horizontal whitespace: spaces and tabs, never a newline.
const H = '[^\\S\\n]'

export function stripClauseDashes(s: string): string {
  if (typeof s !== 'string') return s
  return (
    s
      // Em/en dash splitting two clauses ON THE SAME LINE -> comma. Anchored on
      // a non-space before and after so a LINE-LEADING dash (a list marker, or
      // a wrapped line) is left alone instead of being rewritten into a
      // paragraph that opens with ", ".
      .replace(new RegExp(`(\\S)${H}*[—–]${H}*(?=\\S)`, 'g'), '$1, ')
      .replace(/(\S) - (\S)/g, '$1, $2') // spaced-hyphen splitter -> comma
      .replace(new RegExp(`,${H}*([.,;:!?])`, 'g'), '$1') // no comma before end punctuation
      .replace(new RegExp(`${H}{2,}`, 'g'), ' ') // runs of spaces/tabs -> one space
      // Tidy each line's edges and drop leading/trailing blank lines, but never
      // touch the blank lines BETWEEN paragraphs — that is the structure. This
      // replaces the old unconditional .trim(), which ate the newlines that a
      // body-shaped field depends on.
      .split('\n')
      .map((line) => line.replace(new RegExp(`^${H}+|${H}+$`, 'g'), ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n') // at most one blank line between paragraphs
      .replace(/^\n+|\n+$/g, '')
  )
}

// Deep-walk a value, applying stripClauseDashes to every string. Safe on any
// audience/results object — a clause em-dash never belongs in a content field.
export function sanitizePhrasingDeep<T>(v: T): T {
  if (typeof v === 'string') return stripClauseDashes(v) as unknown as T
  if (Array.isArray(v)) return v.map(sanitizePhrasingDeep) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      // `original` is the editor's as-generated snapshot, used to detect a coach
      // edit and to reset a field back. Sanitizing it would move the baseline
      // that comparison is against, so an untouched field could read as edited.
      // Surviving this pipeline byte-for-byte is the entire point of the field.
      out[k] = k === 'original' ? val : sanitizePhrasingDeep(val)
    }
    return out as T
  }
  return v
}
