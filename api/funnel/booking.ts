import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyManageToken } from '../../lib/funnelLeadToken'
import { loadBooking, resolveFunnelAndLead, formatInTz, MANAGE_CUTOFF_MS, RESCHEDULE_CAP } from '../../lib/bookingManage'
import { loadUserAvailability } from '../../lib/availabilitySettings'

// GET /api/funnel/booking?token=… — PUBLIC self-service manage page for a booked
// lead. Mirrors api/funnel/unsubscribe.ts: never reveal whether a booking
// exists, always answer with a friendly self-contained HTML page. The cancel and
// reschedule actions POST back to the sibling endpoints with the token.
function shell(title: string, inner: string, script = ''): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  *{box-sizing:border-box}html,body{margin:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F4F6F9;color:#0B1120;line-height:1.5;}
  .wrap{max-width:520px;margin:0 auto;padding:56px 20px 64px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{font-size:15px;line-height:24px;color:#4B5563;margin:0 0 14px;}
  .card{background:#fff;border:1px solid #E5E9F0;border-radius:14px;padding:28px;margin-top:8px;}
  .time{font-size:16px;font-weight:700;color:#0B1120;}
  button,.slot{font-family:inherit;cursor:pointer;}
  .danger{margin-top:18px;width:100%;padding:12px 16px;border:1px solid #E5E9F0;border-radius:10px;background:#fff;color:#B42318;font-size:15px;font-weight:600;}
  .slot{display:block;width:100%;text-align:left;margin:6px 0;padding:12px 14px;border:1px solid #E5E9F0;border-radius:10px;background:#fff;color:#0B1120;font-size:15px;}
  .muted{color:#8A94A6;font-size:13px;}
  .err{color:#B42318;font-size:14px;min-height:1.1rem;}
  h2{font-size:16px;margin:24px 0 8px;}
</style></head>
<body><main class="wrap">${inner}</main>${script ? `<script>${script}</script>` : ''}</body></html>`
}

function messagePage(res: VercelResponse, status: number, title: string, message: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.status(status).send(shell(title, `<h1>${title}</h1><p>${message}</p>`))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')

  const rawToken = req.query?.token
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken
  const bookingId = verifyManageToken(token)
  if (!bookingId) {
    return messagePage(res, 400, 'This link is no longer valid', 'Reply to your confirmation email and your coach can help.')
  }

  const booking = await loadBooking(bookingId)
  // Do not reveal existence — a missing booking looks like an invalid link.
  if (!booking || !booking.coach_user_id) {
    return messagePage(res, 400, 'This link is no longer valid', 'Reply to your confirmation email and your coach can help.')
  }
  if (booking.status === 'canceled') {
    return messagePage(res, 200, 'This call is already canceled', "You won't get any more reminders for it.")
  }
  // Inside the cutoff (covers "coming up soon" and "already started/passed"):
  // show neither control, just the message.
  if (new Date(booking.start_time).getTime() - Date.now() < MANAGE_CUTOFF_MS) {
    return messagePage(res, 200, 'Your call is coming up soon', "Your call is coming up soon, so it can't be changed here. Reply to your confirmation email to reach your coach.")
  }

  const [settings, ctx] = await Promise.all([
    loadUserAvailability(booking.coach_user_id),
    resolveFunnelAndLead(booking.coach_user_id, booking.email),
  ])
  const tz = settings.working_hours?.timezone
  const whenLabel = formatInTz(booking.start_time, tz)
  const funnelId = ctx.funnel?.id ? String(ctx.funnel.id) : ''
  const capped = booking.reschedule_count >= RESCHEDULE_CAP

  // When capped, keep the current time + cancel, drop the reschedule panel and
  // show a short line; otherwise render the full pick-a-new-time panel.
  const rescheduleSection = capped
    ? `<p class="muted" style="margin-top:18px;">You've already moved this call twice, so it can't be moved again. You can still cancel, or reply to your confirmation email.</p>`
    : `<h2>Pick a new time</h2>
      <div id="slots"><p class="muted">Loading available times…</p></div>
      <div class="err" id="rerr"></div>`

  const inner = `
    <h1>Manage your call</h1>
    <div class="card">
      <p>Your call is booked for <span class="time">${escapeHtml(whenLabel)}</span>.</p>
      <button type="button" id="cancelBtn" class="danger">Cancel this call</button>
      <div class="err" id="cerr"></div>
      ${rescheduleSection}
    </div>
    <div id="done" style="display:none;" class="card"></div>`

  const rescheduleScript = capped
    ? ''
    : `
    function pick(slotStart, btn){
      var err = document.getElementById('rerr'); err.textContent='';
      document.querySelectorAll('.slot').forEach(function(b){ b.disabled=true; });
      fetch('/api/funnel/booking/reschedule', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token: TOKEN, slot_start: slotStart }) })
        .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
        .then(function(res){
          if (res.ok) { finish('Your call is moved', 'Your new time is confirmed and we sent you an updated calendar invite.'); return; }
          if (res.j && res.j.error === 'slot_taken') { err.textContent = 'That time was just taken. Please pick another.'; loadSlots(); return; }
          if (res.j && (res.j.error === 'cap' || res.j.error === 'cutoff')) { err.textContent = "This call can't be moved right now. Reply to your confirmation email to reach your coach."; return; }
          err.textContent = 'Could not move your call, please try again.';
          document.querySelectorAll('.slot').forEach(function(b){ b.disabled=false; });
        })
        .catch(function(){ err.textContent='Network error, please try again'; document.querySelectorAll('.slot').forEach(function(b){ b.disabled=false; }); });
    }
    function loadSlots(){
      var slotsEl = document.getElementById('slots');
      if (!FUNNEL_ID) { slotsEl.innerHTML = '<p class="muted">No times available right now. Reply to your confirmation email to reach your coach.</p>'; return; }
      slotsEl.innerHTML = '<p class="muted">Loading available times…</p>';
      fetch('/api/funnel/availability?funnel_id=' + encodeURIComponent(FUNNEL_ID)).then(function(r){ return r.json(); }).then(function(j){
        var slots = (j && j.slots) || [];
        if (!slots.length) { slotsEl.innerHTML = '<p class="muted">No open times right now. Please check back soon.</p>'; return; }
        slotsEl.innerHTML = '';
        slots.slice(0, 24).forEach(function(s){
          var b = document.createElement('button'); b.type='button'; b.className='slot'; b.textContent = fmt(s.start);
          b.addEventListener('click', function(){ pick(s.start, b); });
          slotsEl.appendChild(b);
        });
      }).catch(function(){ slotsEl.innerHTML = '<p class="err">Could not load times.</p>'; });
    }
    loadSlots();`

  const script = `
    var TOKEN = ${JSON.stringify(token)};
    var FUNNEL_ID = ${JSON.stringify(funnelId)};
    var doneEl = document.getElementById('done');
    var cardEl = document.querySelector('.card');
    function fmt(iso){ try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
    function finish(title, body){ cardEl.style.display='none'; doneEl.style.display='block'; doneEl.innerHTML = '<h1>'+title+'</h1><p>'+body+'</p>'; }
    document.getElementById('cancelBtn').addEventListener('click', function(){
      var err = document.getElementById('cerr'); err.textContent=''; this.disabled=true;
      fetch('/api/funnel/booking/cancel', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token: TOKEN }) })
        .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
        .then(function(res){
          if (res.ok) { finish('Your call is canceled', "You won't get any more reminders for it. If you'd like to talk after all, you can book again from the training page."); return; }
          err.textContent = res.j && res.j.error === 'cutoff' ? "Your call is coming up soon, so it can't be changed here." : 'Could not cancel, please try again.';
          document.getElementById('cancelBtn').disabled=false;
        })
        .catch(function(){ err.textContent='Network error, please try again'; document.getElementById('cancelBtn').disabled=false; });
    });
    ${rescheduleScript}`

  return res.status(200).send(shell('Manage your call', inner, script))
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
