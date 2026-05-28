import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin as string || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email, first_name, source = 'optin' } = req.body || {}

  if (!email) return res.status(400).json({ error: 'Email required' })

  const validSources = ['optin', 'organic', 'paid_ad', 'referral', 'social_media', 'quiz', 'other']
  const safeSource = validSources.includes(source) ? source : 'optin'

  try {
    const { error } = await supabase
      .from('leads')
      .upsert(
        { email: email.toLowerCase().trim(), first_name: first_name?.trim() || null, source: safeSource },
        { onConflict: 'email' }
      )

    if (error) throw error

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[leads/save]', err)
    return res.status(500).json({ error: 'Failed to save lead' })
  }
}
