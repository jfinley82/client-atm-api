// Quoted-reply stripping for inbound support email.
//
// Deliberately hand-rolled rather than pulled from npm. The obvious library
// (email-reply-parser) is ESM-only, and this repo compiles to CommonJS on
// Vercel's Node runtime — a combination that caused two separate production
// incidents in as many commits: first ERR_REQUIRE_ESM crashing the whole
// webhook module, then, after hiding the import inside a Function constructor
// to dodge TypeScript's downleveling, ERR_MODULE_NOT_FOUND — because the same
// trick that hides the import from TypeScript also hides it from Vercel's
// bundler, which then never ships the package. The dependency was never worth
// that: what follows is ~40 lines against a webhook that already hand-rolls
// its own htmlToText for the same message.
//
// Scope is deliberately narrow. This trims the trailing quoted thread and
// signature off a reply; it does not attempt the library's full multilingual
// matrix. When nothing matches, the original text is returned unchanged —
// a reply stored with its quoted trail still attached is readable, where a
// reply wrongly truncated to nothing is lost.

// Lines that mark the start of the quoted original. Ordered most-specific
// first; the EARLIEST match in the body wins, since everything after the
// first quote header is the thread being replied to.
const QUOTE_HEADERS: RegExp[] = [
  // "On Mon, Aug 3, 2026 at 10:00 AM, Name <email> wrote:" — the Gmail/Apple
  // Mail form, optionally wrapped onto a second line before "wrote:".
  /^\s*-*\s*On\b[\s\S]{0,200}?\bwrote:\s*-*$/im,
  // "-----Original Message-----" (Outlook), any dash count.
  /^\s*-{1,12}\s*original message\s*-{1,12}\s*$/im,
  // Outlook's header block: "From: Name <email>" — matched only with an
  // address present, so a member writing "From: the dashboard" isn't a cut.
  /^\s*From:\s*.*[<\[][^>\]]+@[^>\]]+[>\]]/im,
  // "Sent: Monday, August 3, 2026 10:00 AM" — the other Outlook block header,
  // for the variant that leads with Sent: rather than From:.
  /^\s*Sent:\s*\w+day,\s/im,
  // Common non-English equivalents worth keeping, all same shape as "On …:".
  /^\s*-*\s*Le\b[\s\S]{0,200}?\ba écrit\s*:\s*-*$/im,
  /^\s*-*\s*El\b[\s\S]{0,200}?\bescribió:\s*-*$/im,
  /^\s*-*\s*Am\b[\s\S]{0,200}?\bschrieb\b[\s\S]{0,80}?:\s*-*$/im,
]

// Signature markers. Each matches a WHOLE line, and the marker plus everything
// after it is dropped — a signature is a trailing block ("-- " then a name and
// title), not a single stray line. Anchoring to line start is what keeps
// "I sent from my other account by mistake" as ordinary prose.
const SIGNATURE_MARKERS: RegExp[] = [
  /^\s*--\s*$/, // the RFC 3676 "-- " separator
  /^\s*__{1,}\s*$/,
  /^\s*Sent from my .+$/i,
  /^\s*Sent from \w+( for \w+)?$/i,
  /^\s*Get Outlook for .+$/i,
]

/**
 * Returns just what the sender typed, with the quoted thread and trailing
 * signature removed. Returns the input unchanged when nothing matches.
 */
export function stripQuotedReply(input: string): string {
  const text = String(input || '').replace(/\r\n/g, '\n')
  if (!text.trim()) return ''

  // Cut at the earliest quote header anywhere in the body.
  let cut = text.length
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(text)
    if (m && m.index < cut) cut = m.index
  }
  let body = text.slice(0, cut)

  // Drop any remaining ">"-quoted block. Walking from the end rather than
  // filtering every line keeps a mid-reply quote the member wrote around
  // (inline replying) instead of silently deleting the part they answered.
  const lines = body.split('\n')
  while (lines.length && (/^\s*>/.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) {
    lines.pop()
  }

  // Then the signature block: the first marker line and everything after it.
  const sigAt = lines.findIndex((line) => SIGNATURE_MARKERS.some((re) => re.test(line)))
  if (sigAt >= 0) lines.length = sigAt

  body = lines.join('\n').trim()
  // Never hand back nothing when there WAS something: a reply that is entirely
  // quote-shaped is better stored verbatim than dropped as empty.
  return body || text.trim()
}
