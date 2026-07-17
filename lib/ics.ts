// Minimal RFC 5545 iCalendar generator for a single booked meeting, so the
// confirmation email carries a .ics the customer's calendar app can import.
// Times are emitted as UTC (the trailing Z form), matching how bookings store
// them; the calendar app renders in the recipient's local timezone.

function toIcsUtc(iso: string): string {
  // 2026-07-20T15:30:00.000Z -> 20260720T153000Z
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// Escapes the characters iCalendar text fields require escaping (RFC 5545 §3.3.11).
function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

export function buildBookingIcs(opts: {
  uid: string
  startUtcISO: string
  endUtcISO: string
  summary: string
  description: string
  joinUrl: string
  organizerEmail: string
  attendeeEmail: string
}): string {
  // DTSTAMP is required; derive it from the start so output is deterministic
  // (Date.now() isn't available in this runtime and would break caching anyway).
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Micro-Training Method//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${toIcsUtc(opts.startUtcISO)}`,
    `DTSTART:${toIcsUtc(opts.startUtcISO)}`,
    `DTEND:${toIcsUtc(opts.endUtcISO)}`,
    `SUMMARY:${escapeText(opts.summary)}`,
    `DESCRIPTION:${escapeText(opts.description)}`,
    `URL:${escapeText(opts.joinUrl)}`,
    `LOCATION:${escapeText(opts.joinUrl)}`,
    `ORGANIZER:mailto:${opts.organizerEmail}`,
    `ATTENDEE;RSVP=TRUE:mailto:${opts.attendeeEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n')
}
