import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../../lib/supabase'
import { setCors, noStore } from '../../../lib/cors'
import { requireActiveUser } from '../../../lib/auth'
import { getValidAccessToken } from '../../../lib/googleCalendar'
import { connectionState } from '../../../lib/calendarConnectionHealth'

// GET /api/calendar/google/status — authed.
// { connected, state, calendar_email?, connected_at?, invalid_since? }
//
// THIS ENDPOINT IS A DISCOVERER, and it is the only reason a coach can ever find
// out on their own.
//
// It used to select two columns and return, so it answered "a coach once
// completed the OAuth flow" rather than "this calendar works". Every path that
// could tell the difference ran through getValidAccessToken, and every one of
// those is triggered by a LEAD's traffic — a booking page load, a booking, a
// reschedule. The one page a coach opens on purpose was the only one that never
// checked. So a broken calendar sat green while leads booked slots the coach was
// already busy in.
//
// It is not an extra call to Google. getValidAccessToken returns the cached
// access token while it is still valid and only reaches the network once it has
// expired — and that refresh was going to happen on the next lead's traffic
// anyway. This moves one call earlier; it does not add one. A coach opens
// settings far less often than hourly, so the ceiling is well under one refresh
// per coach per hour.
//
// TWO CONSEQUENCES WORTH STATING RATHER THAN DISCOVERING:
//
//   A GET THAT WRITES. getValidAccessToken persists rotated refresh tokens and
//   now records or clears the health columns, so this handler can mutate. That
//   was already true of the endpoint's callees elsewhere; it is new here.
//
//   IT MUST NEVER FAIL THE RESPONSE. If Google is slow or down, this reports the
//   last stored state. A settings page that 500s because a third party was
//   briefly unreachable is a worse page than one that is briefly out of date —
//   and a transient failure records nothing, so "out of date" is the correct
//   answer rather than a guess.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    // PROBE FIRST, THEN READ. The probe is what may write the health columns, so
    // reading the row before it would report the state we had a moment ago and
    // hide the failure this request just discovered. Swallowed on purpose — see
    // the header: its job here is to update the row, and its return value adds
    // nothing the row does not already say.
    try {
      await getValidAccessToken(userId)
    } catch (probeErr) {
      console.error('[calendar/google/status] probe', probeErr)
    }

    const { data } = await supabase
      .from('calendar_connections')
      .select('calendar_email, connected_at, invalid_since, invalid_reason')
      .eq('user_id', userId)
      .eq('provider', 'google')
      .maybeSingle()

    if (!data) return res.status(200).json({ connected: false, state: 'not_connected' })

    // `connected` STILL MEANS "A ROW EXISTS", and is DEPRECATED.
    //
    // It does not flip to false on a broken connection, for two reasons.
    // Flipping it discards the context that makes the message useful — "we were
    // connected to jamaul@…, and it stopped working on the 3rd" is a different
    // message from "connect your calendar", and the second is what a coach who
    // already connected it sees today. And it would be wrong for
    // app_misconfigured, where there is nothing for the coach to do.
    //
    // The cost is that `connected: true` beside `state: 'needs_reconnect'` is a
    // contradiction a careless caller renders as a green tick, which is the
    // exact defect being fixed. Render `state`. Nothing new should read
    // `connected`; it is here so an existing consumer does not break.
    return res.status(200).json({
      connected: true,
      state: connectionState(data),
      calendar_email: data.calendar_email ?? null,
      connected_at: data.connected_at ?? null,
      invalid_since: data.invalid_since ?? null,
    })
  } catch (err) {
    console.error('[calendar/google/status]', err)
    return res.status(500).json({ error: 'Failed to load status' })
  }
}
