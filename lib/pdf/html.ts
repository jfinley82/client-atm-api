// Minimal HTML escaping for text interpolated into the print-ready document.
// The render engine also strips <script> as a safety net, but every value we
// inject from coach data is escaped here so it can never break out of its slot.
export function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Coerce to a trimmed string; empty when missing.
export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// Coerce to a string array of non-empty trimmed entries.
export function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0)
}
