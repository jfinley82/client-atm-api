import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'
import type { ByCardIdContent } from '../../lib/toolkitsShared'
import type { SlidesDeck } from '../../lib/slidesAnalysis'
import type { QualifierDeck } from '../../lib/qualifierAnalysis'
import type { ProgramAnalysis } from '../../lib/programAnalysis'
import type { ContentAnalysis } from '../../lib/contentAnalysis'

// GET /api/my-micro-trainings
// Read-only assembly view. For each validated Blueprint, reports the status of
// its per-Blueprint assets: Micro-Training Creator ('slides') and AI Coach
// Builder ('qualifier'). Program Creator and Content Creator are account-level
// (one each, not per Blueprint), so they are reported once at the top level.
//
// Storage model:
//   - slides, qualifier: saved_outputs[tool].content.by_card_id[cardId] = Deck
//   - program, content:  saved_outputs[tool].content = single Analysis object
// Every Deck/Analysis carries a `confirmed` boolean, so status is:
//   none (no entry) | draft (entry exists, confirmed !== true) | ready (confirmed)
//
// This is an index/status reader only. Full asset content is fetched from the
// existing per-toolkit GET endpoints when the member opens an item, so this
// payload stays small.

type AssetStatus = 'none' | 'draft' | 'ready'

function statusOf(entry: { confirmed?: boolean } | null | undefined): AssetStatus {
  if (!entry) return 'none'
  return entry.confirmed === true ? 'ready' : 'draft'
}

function byCardId<T>(content: unknown): Record<string, T> {
  const c = content as ByCardIdContent<T> | undefined
  return c?.by_card_id ?? {}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCors(req, res)) return
  if (req.method !== 'GET') return res.status(405).end()
  noStore(res)

  const userId = await requireActiveUser(req, res)
  if (!userId) return

  try {
    const [cardsRes, slidesRow, qualifierRow, programRow, contentRow] = await Promise.all([
      supabase
        .from('problem_solution_cards')
        .select('id, card_name, problem_text')
        .eq('user_id', userId)
        .eq('validated', true)
        .order('created_at', { ascending: true }),
      getSavedOutput(userId, 'slides'),
      getSavedOutput(userId, 'qualifier'),
      getSavedOutput(userId, 'program'),
      getSavedOutput(userId, 'content'),
    ])
    if (cardsRes.error) throw cardsRes.error

    const slidesByCard = byCardId<SlidesDeck>(slidesRow?.content)
    const qualByCard = byCardId<QualifierDeck>(qualifierRow?.content)

    const cards = (cardsRes.data || []) as Array<{ id: string; card_name: string; problem_text: string }>
    const blueprints = cards.map((card) => {
      const slides = slidesByCard[card.id] ?? null
      const coach = qualByCard[card.id] ?? null
      return {
        card_id: card.id,
        card_name: card.card_name,
        problem_text: card.problem_text,
        micro_training: {
          status: statusOf(slides),
          training_title: slides?.training_title ?? null,
          slide_count: Array.isArray(slides?.slides) ? slides!.slides.length : 0,
          duration_estimate: slides?.duration_estimate ?? null,
        },
        ai_coach: {
          status: statusOf(coach),
          has_prompt: !!coach?.system_prompt,
        },
      }
    })

    const program = programRow?.content as ProgramAnalysis | undefined
    const content = contentRow?.content as ContentAnalysis | undefined

    return res.status(200).json({
      blueprints,
      program: {
        status: statusOf(program),
        program_name: program?.program_name ?? null,
        total_weeks: program?.total_weeks ?? null,
        total_sessions: program?.total_sessions ?? null,
      },
      content: {
        status: statusOf(content),
        post_count: Array.isArray(content?.posts) ? content!.posts.length : 0,
        email_count: Array.isArray(content?.emails) ? content!.emails.length : 0,
      },
    })
  } catch (err) {
    console.error('[my-micro-trainings] GET', err)
    return res.status(500).json({ error: 'Failed to load your micro-trainings' })
  }
}
