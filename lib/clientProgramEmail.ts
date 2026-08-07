import { supabase } from './supabase'
import {
  loadCoachBrand,
  brandedEmailHtml,
  scheduleFunnelEmail,
  cancelFunnelSends,
  sendOneOffEmail,
  MTM_BRAND,
} from './email'
import { loadBusinessSettings } from './businessSettings'
import { programPortalUrl } from './clientProgramPortal'
import { zonedInstant, bookingTimeLabel } from './bookingTimezone'
import { APP_URL } from './appUrls'
import type { ProgramRow } from './clientProgramSerializers'

// Client-programme mail and the reminder queue.
//
// COACH-BRANDED, MTM-SENT. The verified sending domain stays MTM's — display
// name, logo, accent, signature and reply-to are the coach's. There is no new
// `mtm-*` template alias for this and none is to be added: the published aliases
// are all MTM-branded, and a client who bought from their coach should not
// receive a letter from a company they have never heard of. The ONE exception is
// the coach's own notification, which is MTM writing to a member.
//
// BEST-EFFORT BY CONTRACT, like every other notification here: try/catch, log,
// never throw. A mail failure must not be able to roll back or fail the write
// that already succeeded.
//
// THERE IS NO CRON. Reminders are scheduled on write through Resend's
// `scheduledAt` and retracted with `cancelFunnelSends`, so the queue is the
// thing that remembers, not a poller.

/** 09:00 in the CLIENT's zone, the day before the item is due. */
export const REMINDER_HOUR = 9
/** Below this, the send is effectively now and scheduling it is a race. */
const MIN_LEAD_MS = 60_000

export type ReminderItem = {
  id: string
  kind: 'week' | 'task' | 'milestone'
  title: string
  due_date: string | null
  status: 'pending' | 'completed'
  reminder_message_id: string | null
}

/**
 * When this item's reminder fires, or null if it should not have one.
 *
 * DST-SAFE BY CONSTRUCTION, because the offset is resolved at the instant being
 * scheduled rather than at the moment of scheduling — see `zonedInstant`. A
 * literal "16:00Z" would be 09:00 in Los Angeles today and 08:00 in December,
 * and the failure would arrive months after the code that caused it.
 *
 * A null `client_timezone` means UTC. That is not a guess: the column is
 * nullable because we genuinely may not know where they are, and UTC is the
 * honest answer to not knowing.
 */
export function reminderInstant(item: Pick<ReminderItem, 'due_date'>, clientTimezone: string | null): string | null {
  if (!item.due_date) return null
  const dayBefore = new Date(Date.parse(`${item.due_date}T00:00:00Z`) - 24 * 60 * 60 * 1000)
  if (!Number.isFinite(dayBefore.getTime())) return null
  return zonedInstant(dayBefore.toISOString().slice(0, 10), REMINDER_HOUR, 0, clientTimezone)
}

/**
 * Does this item want a reminder at all?
 *
 * Deliberately says nothing about WHEN — that is `reminderInstant`, and the
 * lead-time check belongs with the clock rather than with the eligibility rule.
 * Splitting them is what lets this be asserted directly against every state.
 */
export function wantsReminder(program: Pick<ProgramRow, 'status'>, item: Pick<ReminderItem, 'kind' | 'status' | 'due_date'>): boolean {
  // A week row is a heading, not work, and carries no due date anyway.
  if (item.kind === 'week') return false
  if (item.status !== 'pending') return false
  if (!item.due_date) return false
  // Only a LIVE programme mails anybody. A draft has never been sent, and a
  // paused or cancelled one must go quiet — a client who was told their
  // programme is on hold should not keep getting nudges from it.
  return program.status === 'active'
}

/**
 * ONE REMINDER PER ITEM, and this is the only function that decides what it is.
 *
 * Cancel-then-reschedule rather than patch: Resend has no "move this scheduled
 * message" and a second scheduled send would be a duplicate the client sees.
 * Every caller that changes a due date, a position, a status or a start date
 * routes through here, so "the queue matches the plan" is a property of one
 * function rather than of eight call sites agreeing.
 *
 * Returns nothing. A caller that awaited a boolean would be tempted to branch on
 * it, and there is no branch to take: mail is best-effort and the write it
 * follows has already happened.
 */
export async function syncItemReminder(program: ProgramRow, item: ReminderItem, nowMs: number = Date.now()): Promise<void> {
  try {
    // ALWAYS CANCEL FIRST, even when a new one is about to be scheduled. The old
    // message names the old date; leaving it queued while adding a second is how
    // a client gets nudged twice for one task, once on a date that no longer
    // means anything.
    if (item.reminder_message_id) {
      await cancelFunnelSends([item.reminder_message_id])
      await supabase.from('client_program_items').update({ reminder_message_id: null }).eq('id', item.id)
    }

    if (!wantsReminder(program, item)) return
    const at = reminderInstant(item, program.client_timezone)
    if (!at) return
    // Already due, or so close that the schedule call and the send would race.
    // Silently skipped rather than sent immediately: a "due tomorrow" email
    // arriving for something due today is worse than no email.
    if (Date.parse(at) - nowMs < MIN_LEAD_MS) return

    const brand = await loadCoachBrand(program.user_id)
    const url = programPortalUrl(program)
    const html = brandedEmailHtml(brand, {
      heading: `Due tomorrow: ${item.title}`,
      bodyHtml: `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Hi ${escapeHtml(
        firstNameOf(program.client_name)
      )},</p>
      <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">A quick nudge — <strong>${escapeHtml(
        item.title
      )}</strong> is due tomorrow on ${escapeHtml(program.program_name)}.</p>`,
      cta: { label: 'Open my programme', url },
    })

    const messageId = await scheduleFunnelEmail({
      brand,
      funnelId: null,
      leadId: program.lead_id,
      kind: 'program_item_due',
      to: program.client_email,
      subject: `Due tomorrow: ${item.title}`,
      html,
      scheduledAt: at,
    })

    // STORED, because a message id we cannot retrieve is a reminder we cannot
    // retract — and retraction is the whole reason the column exists.
    if (messageId) await supabase.from('client_program_items').update({ reminder_message_id: messageId }).eq('id', item.id)
  } catch (err) {
    console.error('[clientProgramEmail] syncItemReminder', item.id, err)
  }
}

/**
 * Re-sync only the items whose reminder INSTANT could have moved.
 *
 * A resequence or a compaction rewrites positions across the whole plan, but a
 * reminder is keyed on the due date and nothing else — so a row that kept its
 * date keeps its reminder, unchanged, with the same message id. Re-queueing it
 * anyway would cancel a scheduled send and book an identical one, which is
 * churn the client cannot see and the coach's own tests can: a message id that
 * changes for an item nothing happened to is indistinguishable from one that
 * changed because something did.
 */
export async function syncChangedReminders(
  program: ProgramRow,
  before: Array<{ id: string; due_date: string | null }>,
  after: ReminderItem[],
  nowMs: number = Date.now()
): Promise<void> {
  const was = new Map(before.map((b) => [b.id, b.due_date]))
  for (const item of after) {
    // A row that did not exist before is new and wants scheduling; a row whose
    // date is unchanged is left completely alone.
    if (was.has(item.id) && was.get(item.id) === item.due_date) continue
    await syncItemReminder(program, item, nowMs)
  }
}

/** Re-sync every item on a programme. Used on send and on a status change. */
export async function syncAllReminders(program: ProgramRow, nowMs: number = Date.now()): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('client_program_items')
      .select('id, kind, title, due_date, status, reminder_message_id')
      .eq('program_id', program.id)
    if (error) throw error
    for (const item of (data || []) as unknown as ReminderItem[]) {
      await syncItemReminder(program, item, nowMs)
    }
  } catch (err) {
    console.error('[clientProgramEmail] syncAllReminders', program.id, err)
  }
}

/**
 * §12.10 — a completed item stops nagging.
 *
 * Separate from syncItemReminder only in that it needs no programme: cancelling
 * is unconditional, and requiring the parent row would make the cheap half of
 * the lifecycle depend on a read the caller may not have.
 */
export async function cancelItemReminder(item: Pick<ReminderItem, 'id' | 'reminder_message_id'>): Promise<void> {
  if (!item.reminder_message_id) return
  try {
    await cancelFunnelSends([item.reminder_message_id])
    await supabase.from('client_program_items').update({ reminder_message_id: null }).eq('id', item.id)
  } catch (err) {
    console.error('[clientProgramEmail] cancelItemReminder', item.id, err)
  }
}

// ---------------------------------------------------------------------------
// The letters
// ---------------------------------------------------------------------------

/**
 * §11 — sent on SEND, never on create.
 *
 * This is the first thing the client hears about any of it, and it carries the
 * only link they will ever have. A draft that mailed this would tell someone
 * their programme had started while their coach was still editing it.
 */
export async function sendProgramWelcome(program: ProgramRow): Promise<string | null> {
  return safeSend('program_welcome', program, async (brand) => {
    const url = programPortalUrl(program)
    return {
      subject: `Your ${program.program_name} programme is ready`,
      html: brandedEmailHtml(brand, {
        heading: `Welcome to ${program.program_name}`,
        bodyHtml: `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Hi ${escapeHtml(
          firstNameOf(program.client_name)
        )},</p>
        <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Your programme is live. Everything is on one page — what you are working on this week, what is coming, and a way to book your calls with ${escapeHtml(
          brand.coachName
        )}.</p>
        <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Keep this email. The link below is yours and does not expire.</p>`,
        cta: { label: 'Open my programme', url },
      }),
    }
  })
}

/**
 * §7.2 — the client lost their link.
 *
 * MAILED TO THE STORED ADDRESS, NEVER TO THE SUBMITTED ONE. The address in the
 * request body is a lookup key and nothing else; treating it as a destination
 * would turn this into a way to have any client's portal link delivered to an
 * attacker's inbox by typing the client's email into a public form.
 */
export async function sendProgramLinkResend(program: ProgramRow): Promise<string | null> {
  return safeSend('program_link_resend', program, async (brand) => {
    const url = programPortalUrl(program)
    return {
      subject: `Your ${program.program_name} link`,
      html: brandedEmailHtml(brand, {
        heading: 'Here is your programme link',
        bodyHtml: `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Hi ${escapeHtml(
          firstNameOf(program.client_name)
        )},</p>
        <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">You asked for the link to ${escapeHtml(
          program.program_name
        )} again. Here it is — it is the same link as before, so any older email still works too.</p>`,
        cta: { label: 'Open my programme', url },
      }),
    }
  })
}

/** The coach picked a time. The instant is rendered in the CLIENT's zone. */
export async function sendSessionConfirmed(
  program: ProgramRow,
  session: { startIso: string; itemTitle: string | null }
): Promise<string | null> {
  return safeSend('program_session_confirmed', program, async (brand) => {
    // The client's zone, not the coach's and not UTC. A confirmation whose time
    // is right and whose zone is somebody else's is the failure bookingTimeLabel
    // exists for.
    const label = bookingTimeLabel(session.startIso, program.client_timezone)
    const what = session.itemTitle || `your call with ${brand.coachName}`
    return {
      subject: `Confirmed: ${what}`,
      html: brandedEmailHtml(brand, {
        heading: 'Your call is confirmed',
        bodyHtml: `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Hi ${escapeHtml(
          firstNameOf(program.client_name)
        )},</p>
        <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">${escapeHtml(
          brand.coachName
        )} confirmed <strong>${escapeHtml(what)}</strong> for <strong>${escapeHtml(label)}</strong>.</p>`,
        cta: { label: 'Open my programme', url: programPortalUrl(program) },
      }),
    }
  })
}

/** The coach could not make those times. The reason is theirs, verbatim or absent. */
export async function sendSessionDeclined(program: ProgramRow, reason: string | null): Promise<string | null> {
  return safeSend('program_session_declined', program, async (brand) => {
    // NO SUBSTITUTE REASON. A coach who gave none said nothing, and inventing
    // "scheduling conflict" on their behalf puts words in their mouth.
    const because = reason
      ? `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">${escapeHtml(reason)}</p>`
      : ''
    return {
      subject: `About those times for ${program.program_name}`,
      html: brandedEmailHtml(brand, {
        heading: 'Those times did not work',
        bodyHtml: `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Hi ${escapeHtml(
          firstNameOf(program.client_name)
        )},</p>
        <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">${escapeHtml(
          brand.coachName
        )} could not make the times you suggested. Send a couple more and they will get one booked.</p>${because}`,
        cta: { label: 'Suggest new times', url: programPortalUrl(program) },
      }),
    }
  })
}

/**
 * THE ONE THAT GOES THE OTHER WAY — MTM writing to a member about their client.
 *
 * MTM-branded on purpose: this is our product telling a coach something happened
 * in it, not their business writing to them in their own name. Gated on the
 * existing `notification_prefs.new_booking`, because a session request IS a
 * booking request and a coach who turned booking alerts off meant this too.
 */
export async function notifyCoachSessionRequested(
  program: ProgramRow,
  request: { note: string | null; preferred_1: string | null; preferred_2: string | null; itemTitle: string | null }
): Promise<void> {
  try {
    const settings = await loadBusinessSettings(program.user_id)
    if (!settings.notification_prefs.new_booking) return

    const { data: coach } = await supabase.from('users').select('email').eq('id', program.user_id).maybeSingle()
    const to = (coach as { email?: string } | null)?.email
    // No resolvable address is a skip, never an error: the request itself has
    // already been stored and the coach will see it on their programme page.
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return

    const rows = [
      ['Client', program.client_name],
      ['Programme', program.program_name],
      ['For', request.itemTitle || 'an ad-hoc call'],
      ['They suggested', [request.preferred_1, request.preferred_2].filter(Boolean).join(' or ') || 'no times given'],
      ['Note', request.note || '—'],
    ]
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 12px 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#667085;">${escapeHtml(
            String(k)
          )}</td><td style="padding:4px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101828;">${escapeHtml(String(v))}</td></tr>`
      )
      .join('')

    await sendOneOffEmail({
      from: `${MTM_BRAND.fromName} <noreply@mail.microtrainingmethod.com>`,
      to,
      subject: `${program.client_name} asked for a call`,
      html: brandedEmailHtml(MTM_BRAND, {
        heading: `${program.client_name} asked for a call`,
        bodyHtml: `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table>`,
        cta: { label: 'Open the programme', url: `${APP_URL}/clients/${program.id}` },
      }),
    })
  } catch (err) {
    console.error('[clientProgramEmail] notifyCoachSessionRequested', program.id, err)
  }
}

// ---------------------------------------------------------------------------

/**
 * The shared send path for everything the CLIENT receives.
 *
 * One place that loads the brand, records the send and swallows the failure —
 * so "coach-branded, MTM-sent, best-effort, recorded" is a property of this
 * function rather than of five call sites remembering all four.
 */
async function safeSend(
  kind: string,
  program: ProgramRow,
  build: (brand: Awaited<ReturnType<typeof loadCoachBrand>>) => Promise<{ subject: string; html: string }>
): Promise<string | null> {
  try {
    const brand = await loadCoachBrand(program.user_id)
    const { subject, html } = await build(brand)
    return await scheduleFunnelEmail({
      brand,
      // A programme may have no funnel and no lead behind it (§4), so both are
      // nullable here rather than assumed.
      funnelId: null,
      leadId: program.lead_id,
      kind,
      to: program.client_email,
      subject,
      html,
    })
  } catch (err) {
    console.error('[clientProgramEmail]', kind, program.id, err)
    return null
  }
}

function firstNameOf(name: string): string {
  const first = String(name || '').trim().split(/\s+/)[0]
  return first || 'there'
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
