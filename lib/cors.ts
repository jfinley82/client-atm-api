const ALLOWED_ORIGINS = [
  'https://app.clientatmbuilder.com',
  'https://clientatmbuilder.com',
  'https://preview-1779993469816843416.vibepreview.com',
  'https://app.microtrainingmethod.com',
  'https://www.microtrainingmethod.com',
  'https://microtrainingmethod.com',
]

export function setCors(req: any, res: any): boolean {
  const origin = req.headers.origin || ''

  const isAllowed = ALLOWED_ORIGINS.includes(origin)
    || origin.endsWith('.vibepreview.com')
    || origin.endsWith('.vercel.app')
    || origin.endsWith('.ghl.systems')
    || origin.endsWith('.highlevel.com')

  const allowOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0]

  res.setHeader('Access-Control-Allow-Origin', allowOrigin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return true
  }
  return false
}
