import { loadCoachBrand, brandedEmailHtml, scheduleFunnelEmail } from './email'
import { programPortalUrl } from './clientProgramPortal'
import type { ProgramRow } from './clientProgramSerializers'

// Client-programme mail. COACH-BRANDED, MTM-SENT.
//
// The verified sending domain stays MTM's — display name, logo, accent,
// signature and reply-to are the coach's. There is no new `mtm-*` template
// alias for this and none is to be added: the published aliases are all
// MTM-branded, and a client who bought from their coach should not receive a
// letter from a company they have never heard of.
//
// BEST-EFFORT BY CONTRACT, like every other notification here: try/catch inside
// scheduleFunnelEmail, log, never throw. A mail failure must not be able to roll
// back or fail the request that already succeeded.

/**
 * §7.2 — the client lost their link.
 *
 * MAILED TO THE STORED ADDRESS, NEVER TO THE SUBMITTED ONE. The address in the
 * request body is a lookup key and nothing else; treating it as a destination
 * would turn this into a way to have any client's portal link delivered to an
 * attacker's inbox by typing the client's email into a public form.
 */
export async function sendProgramLinkResend(program: ProgramRow): Promise<string | null> {
  const brand = await loadCoachBrand(program.user_id)
  const url = programPortalUrl(program)
  const html = brandedEmailHtml(brand, {
    heading: 'Here is your programme link',
    bodyHtml: `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">Hi ${escapeHtml(
      firstNameOf(program.client_name)
    )},</p>
    <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#344054;">You asked for the link to ${escapeHtml(
      program.program_name
    )} again. Here it is — it is the same link as before, so any older email still works too.</p>`,
    cta: { label: 'Open my programme', url },
  })

  return scheduleFunnelEmail({
    brand,
    // A programme may have no funnel and no lead behind it (§4), so both are
    // nullable here rather than assumed.
    funnelId: null,
    leadId: program.lead_id,
    kind: 'program_link_resend',
    to: program.client_email,
    subject: `Your ${program.program_name} link`,
    html,
  })
}

function firstNameOf(name: string): string {
  const first = String(name || '').trim().split(/\s+/)[0]
  return first || 'there'
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
