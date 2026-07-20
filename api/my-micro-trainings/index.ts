import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../lib/supabase'
import { requireActiveUser } from '../../lib/auth'
import { setCors, noStore } from '../../lib/cors'
import { getSavedOutput } from '../../lib/savedOutputs'
import type { ByCardIdContent } from '../../lib/toolkitsShared'
import type { QualifierDeck } from '../../lib/qualifierAnalysis'
import type { ProgramAnalysis } from '../../lib/programAnalysis'
import type { ContentAnalysis } from '../../lib/contentAnalysis'
import { MatcherAnalysis } from '../../lib/matcherAnalysis'
import {
  loadSynopsisInputs,
  resolveScoring,
  resolveSynopsis,
  BlueprintCardRow,
} from '../../lib/blueprintEnrichment'

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

// 60s headroom: this also lazily regenerates null blueprint synopses on first
// read (~8s cold for up to 3), so keep the ceiling clear of a timeout.
export const config = { maxDuration: 60 }

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
    const [cardsRes, mtmRes, qualifierRow, programRow, contentRow, matcherRow, synopsisInputs] = await Promise.all([
      supabase
        .from('problem_solution_cards')
        .select('id, card_name, problem_text, reasoning, suggested_offer, source_problem_id, synopsis')
        .eq('user_id', userId)
        .eq('validated', true)
        .order('created_at', { ascending: true }),
      supabase
        .from('mtm_generations')
        .select('card_id, chosen_topic, slides, emails, book_a_call_emails, workbook, recording_tips')
        .eq('user_id', userId),
      getSavedOutput(userId, 'qualifier'),
      getSavedOutput(userId, 'program'),
      getSavedOutput(userId, 'content'),
      getSavedOutput(userId, 'matcher_analysis'),
      loadSynopsisInputs(userId),
    ])
    if (cardsRes.error) throw cardsRes.error
    if (mtmRes.error) throw mtmRes.error

    // Canonical per-card generation rows (Build + Launch presence).
    const mtmByCard = new Map<string, Record<string, unknown>>()
    for (const row of mtmRes.data || []) mtmByCard.set(row.card_id as string, row)
    const qualByCard = byCardId<QualifierDeck>(qualifierRow?.content)
    const matcher = (matcherRow?.content ?? null) as MatcherAnalysis | null

    const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
    const workbookPopulated = (v: unknown): boolean =>
      !!v && typeof v === 'object' && len((v as { sections?: unknown }).sections) > 0

    const cards = (cardsRes.data || []) as BlueprintCardRow[]
    const blueprints = await Promise.all(
      cards.map(async (card) => {
        const gen = mtmByCard.get(card.id)
        const coach = qualByCard[card.id] ?? null
        const scoring = resolveScoring(card, matcher)
        const synopsis = await resolveSynopsis(userId, card, synopsisInputs)

        const slideCount = len(gen?.slides)
        const emailCount = len(gen?.emails)
        const bookACallCount = len(gen?.book_a_call_emails)
        const tipCount = len(gen?.recording_tips)
        const hasWorkbook = workbookPopulated(gen?.workbook)
        const chosenTopic = typeof gen?.chosen_topic === 'string' && gen.chosen_topic.trim().length > 0 ? gen.chosen_topic : null
        // Build = slides present. Launch = emails + book_a_call + workbook.
        const buildReady = slideCount > 0
        const launchReady = emailCount > 0 && bookACallCount > 0 && hasWorkbook

        return {
          card_id: card.id,
          card_name: card.card_name,
          problem_text: card.problem_text,
          // Full Blueprint-card fields so the shared card can render its synopsis.
          reasoning: card.reasoning,
          suggested_offer: card.suggested_offer,
          match_strength: scoring.match_strength,
          match_factors: scoring.match_factors,
          synopsis,
          build: { status: (buildReady ? 'ready' : 'none') as AssetStatus },
          launch: { status: (launchReady ? 'ready' : 'none') as AssetStatus },
          assets: {
            chosen_topic: chosenTopic,
            slide_count: slideCount,
            has_workbook: hasWorkbook,
            email_count: emailCount,
            book_a_call_count: bookACallCount,
            recording_tip_count: tipCount,
          },
          ai_coach: {
            status: statusOf(coach),
            has_prompt: !!coach?.system_prompt,
          },
        }
      })
    )

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
