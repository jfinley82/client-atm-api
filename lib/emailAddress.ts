// Is this a usable email address? ONE definition, for every entry point.
//
// This lived as six byte-identical copies of `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`,
// two of them on public forms. One regex in six files is how validation drifts:
// tightening it in the place you happen to be looking leaves the other five
// answering the old question, and nothing anywhere says they were meant to
// agree.
//
// NOT in lib/pgFilters.ts, deliberately. That file is about PostgREST FILTER
// SYNTAX — a value being read as a pattern or a clause list when it was meant as
// a value. This is input validation on a public form. Related in origin, but
// filing one under the other would put a rule about what we accept inside a file
// about how we query, and the next person would look for it in neither.
//
// ---------------------------------------------------------------------------
// TWO DIFFERENT JOBS, AND THIS ONE IS THE SMALLER OF THEM
// ---------------------------------------------------------------------------
//
// This validator is about WHAT ACCUMULATES. `escapeLike` is about WHAT IS SAFE
// TO READ. They are not two layers of the same control and this one does not
// retire the other.
//
// The reason, precisely: `_` is a LIKE wildcard AND legal `atext` in a local
// part, so `foo_bar@example.com` is simultaneously a real address and a pattern
// matching `fooXbar@example.com`. No validator can reject it without rejecting
// a real person. So the class stays open no matter how strict this gets, and
// `escapeLike` is the only thing that closes it.
//
// **Do not delete an escape on the grounds that the input is validated now.**
// It is not, and cannot be, validated enough for that.
//
// What this DOES buy: `%` cannot appear in a hostname, so requiring the part
// after the last `@` to look like a domain rejects `%@%.%` — an address that is
// no address at all and is currently a legal public opt-in — while leaving
// `foo%bar@example.com` alone. It shrinks the junk to a narrow over-match. That
// is worth having; it is not a boundary.
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY REFUSES, so it is recorded rather than discovered
// ---------------------------------------------------------------------------
//
// IP-LITERAL DOMAINS. `user@[192.168.1.1]` is legal under RFC 5321 and is now
// rejected. Nobody signing up to a coaching funnel types one. This is a change
// in behaviour, not a clarification.
//
// Everything else errs toward ACCEPTING. A false accept is a junk row in a
// table; a false reject is a lost customer on a public form, silently, with
// nothing reported. Where the two are in tension the answer is to accept:
//
//   - The local part stays as permissive as it was: anything but `@` and
//     whitespace. `%`, `_`, `+`, `'`, and a single character all pass.
//   - Labels allow any Unicode letter or digit, so `x@пример.рф` is accepted
//     rather than refused for not being ASCII. `%` and `_` are neither a letter
//     nor a digit in any script, which is what makes the rejection precise
//     rather than incidental.
//   - The final label may be letters, or a punycode `xn--` label, so IDN
//     domains in their encoded form are accepted too.
//   - A trailing dot (`x@example.com.`, a legal FQDN) is accepted.

// Domain labels: letter/digit at each end, hyphens allowed inside. No empty
// labels, so `a..b` and a leading or trailing dot inside the name are refused.
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`
// The final label is a TLD: letters only, or punycode. Never all digits — that
// is the shape of an unbracketed IPv4, which is not a domain.
const TLD = String.raw`(?:[\p{L}]{2,}|xn--[\p{L}\p{N}-]+)`

const DOMAIN_RE = new RegExp(String.raw`^(?:${LABEL}\.)+${TLD}\.?$`, 'u')

/**
 * A usable email address.
 *
 * A type predicate rather than a bare boolean, because every call site
 * immediately uses the value it just validated. The inline regex this replaced
 * narrowed `string | undefined` to `string` as a side effect of its own
 * `typeof` guard; without the predicate each caller would need a cast, and a
 * cast is a place to be wrong about the thing that was just checked.
 *
 * Split on the LAST `@`, not the first: `"a@b"@example.com` is a legal quoted
 * local part, and splitting on the first would hand `b"@example.com` to the
 * domain check and reject it.
 */
export function isEmailAddress(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const value = v.trim()
  if (!value || /\s/.test(value)) return false

  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return false

  const local = value.slice(0, at)
  const domain = value.slice(at + 1)

  // The local part keeps the old rule exactly: anything but `@` and whitespace.
  // Tightening it is where the false rejects live.
  if (local.includes('@')) return false

  return DOMAIN_RE.test(domain)
}

/** Trimmed and lowercased, or null when it is not an address at all. */
export function normalizeEmailAddress(v: unknown): string | null {
  return isEmailAddress(v) ? String(v).trim().toLowerCase() : null
}

/**
 * An address from a SPREADSHEET COLUMN.
 *
 * Same address rule, plus one extra rejection that is not about addresses at
 * all: a comma or semicolon means the column splitter failed and two fields ran
 * together, or the admin pasted a list into a single cell. `,` and `;` are only
 * legal in a quoted local part, and nothing a spreadsheet exports is quoted, so
 * refusing them costs nobody and catches a real and common import fault.
 *
 * Kept here rather than in each importer because there were TWO importers doing
 * it, with two slightly different regexes — lib/coachContacts.ts required a
 * single dot, lib/memberInvite.ts required one or more. That divergence is the
 * whole reason this file exists.
 */
export function isImportableEmailAddress(v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (/[,;]/.test(v)) return false
  return isEmailAddress(v)
}
