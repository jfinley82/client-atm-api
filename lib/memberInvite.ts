import crypto from 'crypto'
import { supabase } from './supabase'
import { sendMagicLinkEmail } from './email'
import { hasCapability, isMembershipTier, MEMBERSHIP_TIERS } from './entitlements'
import { INVITE_TTL_MS } from './tokenLifetimes'

// Member provisioning: the shared half of POST /api/admin/members and
// POST /api/admin/members/bulk. Both call createMember() so a single create and
// a forty-row import cannot disagree about what "already exists" means, which
// tiers are legal, or when an invite is sent.
//
// There is deliberately NO public entry point here. Every caller of
// createMember is admin-gated; api/auth/send-magic-link.ts stays lookup-only.

// The two lifetimes live in lib/tokenLifetimes.ts, which imports nothing —
// lib/email.ts needs them too, and this module imports lib/email.ts, so a
// constant defined here would close an import cycle. Re-exported so callers of
// this module do not need to know that.
export { LOGIN_TTL_MS, INVITE_TTL_MS, ttlForKind, type TokenKind } from './tokenLifetimes'

// ── Email ────────────────────────────────────────────────────────────────────

// The SAME normalisation api/auth/send-magic-link.ts applies before its lookup.
// If these two ever disagree, an admin creates "Jane@x.com" and Jane can never
// log in, because her lookup normalises to an address the row does not carry.
export function normalizeMemberEmail(raw: string): string {
  return raw.toLowerCase().trim()
}

// Deliberately conservative rather than RFC-complete: it must reject the things
// a spreadsheet actually produces — an empty cell, a name in the email column,
// a trailing comma, "jane at example dot com" — without rejecting a real
// address for being unusual. A false reject in a bulk import is a row the admin
// has to chase; a false accept is one bounced email.
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@.,;]+(\.[^\s@.,;]+)+$/

// Returns a plain boolean, NOT a `value is string` predicate: narrowing here
// would type the negative branch of an already-string caller as `never`, and
// the rejection path needs to echo the offending value back to the admin.
export function isPlausibleEmail(value: unknown): boolean {
  return typeof value === 'string' && EMAIL_SHAPE.test(value.trim())
}

// ── Invites ──────────────────────────────────────────────────────────────────

export type InviteResult =
  | { sent: true; expires_at: string }
  | { sent: false; reason: 'not_requested' | 'no_app_access' | 'send_failed'; message: string }

/**
 * Mint a single-use invite token. Same table and same redemption path as a
 * login link — api/auth/callback.ts checks used_at, checks expiry, checks for a
 * suspended account and mints the session — differing only in `kind` and
 * therefore in lifetime.
 */
export async function issueInviteToken(userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString()

  const { error } = await supabase
    .from('magic_link_tokens')
    .insert({ user_id: userId, token, expires_at: expiresAt, kind: 'invite' })
  if (error) throw error

  return { token, expiresAt }
}

/**
 * Mint an invite and mail it. Returns WHAT HAPPENED rather than throwing,
 * because "the member was created but the email did not go" is information the
 * admin needs on screen, not a 500 that hides a successful write.
 *
 * A tier without `app_login` gets no invite: the link would redeem into a
 * session for an account that cannot use the app, so sending it would be a
 * promise we do not keep. That case is reported, never silent.
 */
export async function sendMemberInvite(member: {
  id: string
  email: string
  name: string | null
  membership_tier: string
  role?: string | null
}): Promise<InviteResult> {
  if (!hasCapability(member.membership_tier, member.role ?? 'user', 'app_login')) {
    return {
      sent: false,
      reason: 'no_app_access',
      message:
        `membership_tier '${member.membership_tier}' has no app_login capability, so no invite was sent. ` +
        `The member exists and can be invited by changing their tier.`,
    }
  }

  try {
    const { token, expiresAt } = await issueInviteToken(member.id)
    await sendMagicLinkEmail(member.email, member.name || '', token)
    return { sent: true, expires_at: expiresAt }
  } catch (err) {
    console.error('[memberInvite] send failed', member.id, err)
    return {
      sent: false,
      reason: 'send_failed',
      message: 'The member was created but the invite email could not be sent. Resend it from the member row.',
    }
  }
}

// ── Creating a member ────────────────────────────────────────────────────────

export const MEMBER_COLUMNS =
  'id, email, name, profession, has_paid, quiz_completed, quiz_score, video_watched, membership_tier, status, role, add_ons, created_at'

// Columns of an already-existing member, for the conflict payload. Enough for
// an admin to see WHO they collided with and decide, without a second request.
const EXISTING_COLUMNS = 'id, email, name, membership_tier, status, created_at'

export type MemberRow = Record<string, unknown> & { id: string; email: string }

export type ExistingMember = {
  id: string
  email: string
  name: string | null
  membership_tier: string
  status: string
  created_at?: string
}

export type RejectReason =
  | 'email_required'
  | 'email_malformed'
  | 'name_required'
  | 'invalid_tier'
  | 'invalid_add_ons'
  | 'duplicate_in_payload'
  | 'write_failed'

export type CreateMemberResult =
  | { outcome: 'created'; member: MemberRow; invite: InviteResult }
  | {
      outcome: 'skipped_existing'
      email: string
      existing: ExistingMember
    }
  | { outcome: 'rejected'; email: string | null; reason: RejectReason; message: string }

export type CreateMemberInput = {
  name?: unknown
  email?: unknown
  membership_tier?: unknown
  add_ons?: unknown
  send_invite?: unknown
}

const VALID_ADD_ON_KEYS = ['funnel_builder']

/**
 * Create one member. Never throws for an input problem and never throws for a
 * collision — both are outcomes the caller reports. Bulk import depends on
 * that: forty rows must not be abandoned because row three had a typo.
 *
 * An existing email is a DECISION, not an error. Returning the existing member
 * lets an admin see they are re-importing the same person, which is the normal
 * case when the same people attend more than one workshop. Silently updating
 * their tier would be the dangerous alternative: a workshop CSV would quietly
 * demote a paying member.
 */
export async function createMember(input: CreateMemberInput): Promise<CreateMemberResult> {
  const rawEmail = typeof input.email === 'string' ? input.email : ''
  if (!rawEmail.trim()) {
    return { outcome: 'rejected', email: null, reason: 'email_required', message: 'email is required' }
  }
  if (!isPlausibleEmail(rawEmail)) {
    return {
      outcome: 'rejected',
      email: rawEmail.trim(),
      reason: 'email_malformed',
      message: `'${rawEmail.trim()}' does not look like an email address`,
    }
  }
  const email = normalizeMemberEmail(rawEmail)

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) {
    return { outcome: 'rejected', email, reason: 'name_required', message: 'name is required' }
  }

  if (!isMembershipTier(input.membership_tier)) {
    return {
      outcome: 'rejected',
      email,
      reason: 'invalid_tier',
      message: `membership_tier must be one of: ${MEMBERSHIP_TIERS.join(', ')}`,
    }
  }
  const membership_tier = input.membership_tier

  // Same validation shape PATCH /api/admin/members/[id] applies, so a member
  // cannot be created holding an add_ons object that endpoint would refuse.
  let add_ons: Record<string, boolean> | undefined
  if (input.add_ons !== undefined) {
    const value = input.add_ons
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.entries(value as Record<string, unknown>).every(
        ([k, v]) => VALID_ADD_ON_KEYS.includes(k) && typeof v === 'boolean'
      )
    ) {
      return {
        outcome: 'rejected',
        email,
        reason: 'invalid_add_ons',
        message: `add_ons must be an object of boolean flags; known keys: ${VALID_ADD_ON_KEYS.join(', ')}`,
      }
    }
    add_ons = value as Record<string, boolean>
  }

  // Look before inserting so the common collision returns a useful payload
  // rather than a constraint error. The insert below still handles the race.
  const { data: existing } = await supabase
    .from('users')
    .select(EXISTING_COLUMNS)
    .eq('email', email)
    .maybeSingle()

  if (existing) {
    return { outcome: 'skipped_existing', email, existing: existing as ExistingMember }
  }

  const { data, error } = await supabase
    .from('users')
    .insert({
      email,
      name,
      membership_tier,
      status: 'active',
      ...(add_ons ? { add_ons } : {}),
    })
    .select(MEMBER_COLUMNS)
    .maybeSingle()

  if (error) {
    // 23505 on users_email_key: someone inserted the same address between our
    // lookup and our write. That is still "already exists", not a failure —
    // reporting it as one would make a concurrent bulk import non-idempotent.
    if ((error as { code?: string }).code === '23505') {
      const { data: raced } = await supabase
        .from('users')
        .select(EXISTING_COLUMNS)
        .eq('email', email)
        .maybeSingle()
      if (raced) return { outcome: 'skipped_existing', email, existing: raced as ExistingMember }
    }
    console.error('[memberInvite] create failed', email, error)
    return { outcome: 'rejected', email, reason: 'write_failed', message: 'Failed to create the member' }
  }

  if (!data) {
    return { outcome: 'rejected', email, reason: 'write_failed', message: 'Failed to create the member' }
  }

  const member = data as MemberRow
  const wantsInvite = input.send_invite !== false // default ON: the point of the feature is a working login

  const invite: InviteResult = wantsInvite
    ? await sendMemberInvite({
        id: member.id,
        email: member.email,
        name: (member.name as string | null) ?? null,
        membership_tier,
        role: (member.role as string | null) ?? 'user',
      })
    : { sent: false, reason: 'not_requested', message: 'send_invite was false; no invite was sent' }

  return { outcome: 'created', member, invite }
}
