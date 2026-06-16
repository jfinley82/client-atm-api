import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { email } = req.body || {}
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email required' })
  }

  try {
    const { error } = await supabase
      .from('users')
      .update({ status: 'suspended' })
      .eq('email', email.toLowerCase().trim())

    if (error) throw error
    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[members/suspend]', err)
    return res.status(500).json({ error: 'Failed to suspend member' })
  }
}
