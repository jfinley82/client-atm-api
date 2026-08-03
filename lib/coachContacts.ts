import { supabase } from './supabase'

// The coach's own list. Account-level, deliberately not funnel_leads — see the
// comment on the table in migration 078.

export type ParsedContact = { email: string; first_name: string | null }

export type ParseResult = {
  contacts: ParsedContact[]
  /** Rows read from the file, excluding the header. */
  total: number
  /** Rows dropped for a malformed or missing email. */
  invalid: number
  /** Rows dropped because the same address appeared earlier in the file. */
  duplicate: number
}

// Deliberately permissive: this validates that an address is worth attempting,
// not that it exists. Resend and the bounce webhook are the real filter, and a
// stricter regex would silently drop deliverable addresses.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

const EMAIL_HEADERS = ['email', 'email address', 'e-mail', 'email_address']
const NAME_HEADERS = ['first_name', 'first name', 'firstname', 'name', 'given name']

/**
 * Minimal RFC-4180 line splitter: quoted fields, "" escapes, commas inside
 * quotes. A dependency would buy edge cases we don't need — but naive
 * `split(',')` corrupts any row with a quoted "Last, First", which real
 * exports are full of.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out.map((f) => f.trim())
}

/**
 * Parses a CSV into contacts. Header-driven when the file has one, falling back
 * to "first column that looks like an email" so a bare one-column export still
 * imports instead of erroring.
 */
export function parseContactsCsv(raw: string): ParseResult {
  const text = String(raw || '').replace(/^﻿/, '')
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { contacts: [], total: 0, invalid: 0, duplicate: 0 }

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  const headerHasEmail = header.some((h) => EMAIL_HEADERS.includes(h))

  let emailIdx = header.findIndex((h) => EMAIL_HEADERS.includes(h))
  let nameIdx = header.findIndex((h) => NAME_HEADERS.includes(h))
  const rows = headerHasEmail ? lines.slice(1) : lines

  if (!headerHasEmail) {
    // No recognisable header — find the column holding an address in row one.
    const first = splitCsvLine(lines[0])
    emailIdx = first.findIndex((c) => EMAIL_RE.test(c))
    nameIdx = -1
  }

  const contacts: ParsedContact[] = []
  const seen = new Set<string>()
  let invalid = 0
  let duplicate = 0

  for (const line of rows) {
    const cells = splitCsvLine(line)
    // Fall back to scanning the row: exports move the email column around.
    const rawEmail =
      (emailIdx >= 0 ? cells[emailIdx] : undefined) ?? cells.find((c) => EMAIL_RE.test(c)) ?? ''
    const email = rawEmail.trim().toLowerCase()

    if (!EMAIL_RE.test(email)) {
      invalid++
      continue
    }
    if (seen.has(email)) {
      duplicate++
      continue
    }
    seen.add(email)

    const first_name = nameIdx >= 0 ? (cells[nameIdx] || '').trim() : ''
    contacts.push({ email, first_name: first_name || null })
  }

  return { contacts, total: rows.length, invalid, duplicate }
}

export type ImportResult = {
  imported: number
  updated: number
  total: number
  invalid: number
  duplicate: number
  filename: string | null
}

/**
 * Upserts a parsed list onto (user_id, lower(email)).
 *
 * Re-uploading a list updates names and the source filename rather than
 * duplicating rows, and — critically — never resurrects an unsubscribe:
 * `unsubscribed` is not in the update, so a contact who opted out stays out
 * even if the coach re-imports the same CSV.
 */
export async function importContacts(
  userId: string,
  parsed: ParseResult,
  filename: string | null,
): Promise<ImportResult> {
  if (parsed.contacts.length === 0) {
    return {
      imported: 0,
      updated: 0,
      total: parsed.total,
      invalid: parsed.invalid,
      duplicate: parsed.duplicate,
      filename,
    }
  }

  const emails = parsed.contacts.map((c) => c.email)
  const { data: existingRows } = await supabase
    .from('coach_contacts')
    .select('email')
    .eq('user_id', userId)
    .in('email', emails)
  const existing = new Set((existingRows || []).map((r) => String(r.email).toLowerCase()))

  const { error } = await supabase.from('coach_contacts').upsert(
    parsed.contacts.map((c) => ({
      user_id: userId,
      email: c.email,
      first_name: c.first_name,
      source_filename: filename,
    })),
    { onConflict: 'user_id,email' },
  )
  if (error) throw error

  const updated = parsed.contacts.filter((c) => existing.has(c.email)).length
  return {
    imported: parsed.contacts.length - updated,
    updated,
    total: parsed.total,
    invalid: parsed.invalid,
    duplicate: parsed.duplicate,
    filename,
  }
}

export type ContactsSummary = {
  count: number
  subscribed: number
  last_filename: string | null
  last_imported_at: string | null
}

/** Cheap header for the Emails tab: how many, and where they came from. */
export async function contactsSummary(userId: string): Promise<ContactsSummary> {
  const [{ count }, { count: subscribed }, { data: latest }] = await Promise.all([
    supabase.from('coach_contacts').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase
      .from('coach_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('unsubscribed', false),
    supabase
      .from('coach_contacts')
      .select('source_filename, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return {
    count: count ?? 0,
    subscribed: subscribed ?? 0,
    last_filename: (latest?.source_filename as string) ?? null,
    last_imported_at: (latest?.created_at as string) ?? null,
  }
}

/** Everyone still mailable for this coach. */
export async function loadSendableContacts(
  userId: string,
): Promise<{ id: string; email: string; first_name: string | null }[]> {
  const { data, error } = await supabase
    .from('coach_contacts')
    .select('id, email, first_name')
    .eq('user_id', userId)
    .eq('unsubscribed', false)
  if (error) throw error
  return (data || []) as { id: string; email: string; first_name: string | null }[]
}
