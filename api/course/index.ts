import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireActiveUser } from '../../lib/auth'
import { setCors } from '../../lib/cors'
import { getCourseState, withStatuses } from '../../lib/course'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const { lessons, completedAtById } = await getCourseState(userId)
    return res.status(200).json({ lessons: withStatuses(lessons, completedAtById) })
  } catch (err) {
    console.error('[course] GET', err)
    return res.status(500).json({ error: 'Failed to load course' })
  }
}
