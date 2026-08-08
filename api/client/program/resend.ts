import { escapeLike } from '../../../lib/pgFilters'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { rateLimit, clientIp } from '../../../lib/rateLimit'
import { PROGRAM_COLUMNS } from '../../../lib/clientProgramAccess'
import { sendProgramLinkResend } from '../../../lib/clientProgramEmail'
import type { ProgramRow } from '../../../lib/clientProgramSerializers'

// POST /api/client/program/resend — body { email }. PUBLIC, no token.
//
// The client lost their link. There is no account to log into, so this is the
// whole of self-service recovery.
//
// THE RESPONSE NEVER VARIES. Same status, same body, same shape whether the
// address matches an active programme or nothing at all — otherwise this is an
// oracle that answers "is this person a client of this platform" for any address
// anyone cares to type.
//
// AND THE RATE LIMIT IS NOT THE CONTROL. lib/rateLimit's own header says it
// "throttles a hot instance rather than enforcing a global quota" and is "not to
// be a security boundary"; it is here to blunt casual abuse of a public write.
// What actually prevents enumeration is that the response carries no
// information and the token is unguessable — and that the mail goes to the
// STORED address, so a successful lookup delivers nothing to the person asking.
export const config = { maxDuration: 30 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).end()
  noStore(res)

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const email = typeof body.email === 'string' ? body.email.trim() : ''

  // Even the rate-limited answer is the same body. A 429 here would be the
  // enumeration signal the uniform 200 exists to remove, distinguishable by
  // whoever is enumerating from the first request onwards.
  const allowed = rateLimit(`program_resend:${clientIp(req)}`, 5, 60_000)

  try {
    if (allowed && email) {
      // ACTIVE ONLY. A draft was never sent, and a canceled or completed
      // programme's link 404s at the portal — mailing one would be a link to a
      // door that is already shut.
      const { data } = await supabase
        .from('client_programs')
        .select(PROGRAM_COLUMNS)
        .ilike('client_email', escapeLike(email))
        .eq('status', 'active')
        .limit(1)
      const program = ((data || []) as unknown as ProgramRow[])[0]
      // program.client_email, not `email`. The submitted address is a key.
      if (program) await sendProgramLinkResend(program)
    }
  } catch (err) {
    // Swallowed on purpose. An error here must not be the one case that answers
    // differently — a 500 on a real address and a 200 on an unknown one is the
    // same oracle wearing a different status code.
    console.error('[client/program/resend]', err)
  }

  return res.status(200).json({ ok: true })
}

