// User input reaching a PostgREST filter is SYNTAX, not a value.
//
// Both helpers here exist because a value interpolated into a filter is parsed
// before it is compared, so a character that means something to the parser
// selects rows nobody asked for. Neither is about escaping "unsafe" characters
// in the injection sense — PostgREST is not concatenating SQL — it is about a
// string being read as a pattern or as a clause list when it was meant as a
// value.
//
// ONE OWNER, because the alternative is a copy per call site that drifts. Three
// copies of the LIKE escaper existed for exactly one commit, which is what
// prompted this file.

/**
 * `ilike`/`like` take a PATTERN, so `%` and `_` in the VALUE are wildcards.
 *
 * The live case: `api/funnel/lead.ts` validates opt-in addresses with
 * `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`, which accepts `%` — so `%@%.%` is both a
 * legal address on a PUBLIC form and a pattern matching every email in the
 * table. Every unescaped `.ilike('email', <stored address>)` downstream then
 * matched every row, and one of those reads fed a WRITE.
 *
 * Note the direction of the trap: the value comes out of our own database, so
 * it reads as trusted. It is only as trusted as the least careful writer of that
 * column, and that writer is a public form.
 *
 * `\` FIRST, or it re-escapes the backslashes the other two branches add.
 */
export function escapeLike(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * `or=` is a COMMA-SEPARATED, PAREN-DELIMITED clause list.
 *
 * A comma, paren or backslash in user input is read as filter syntax and
 * silently selects the wrong rows. Stripped rather than escaped: `or=` has no
 * escape mechanism worth relying on, and a search box losing a comma is a
 * better outcome than a filter that means something else.
 *
 * This does NOT handle `%`/`_` — a clause inside `or=` that uses `ilike` needs
 * `escapeLike` on its value as well, and the two are separate concerns.
 */
export function escapeForOr(s: string): string {
  return s.replace(/[,()\\]/g, ' ')
}
