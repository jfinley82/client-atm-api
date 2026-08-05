import { supabase } from './supabase'
import { verifyCoachToken } from './funnelLeadToken'
import { hasFunnelBuilderAccess } from './funnels'
import { getSavedOutput } from './savedOutputs'
import { AICoachContent } from './aiCoach'

// The gate every lead-facing AI coach endpoint runs first.
//
// A lead is anonymous and free — they never authenticate as a user. What
// authorizes the request is a signed coach token naming a (funnel, lead) pair,
// plus three server-side re-checks that the token itself cannot assert:
//
//   1. the lead really belongs to the funnel the token names
//   2. the funnel's OWNER is entitled (same funnel-builder gate the studio uses)
//   3. that owner has ACTIVATED a bot (ai_coach saved with confirmed: true)
//
// Every failure returns the same not_active/404 shape. A lead must not be able
// to tell an expired token from an unentitled coach from a coach who never
// finished their bot — that is the coach's business, not the visitor's.

export type LeadSession = {
  leadId: string
  funnelId: string
  coachUserId: string
  lead: Record<string, any>
  funnel: Record<string, any>
  aiCoach: AICoachContent
}

export type SessionResult = { ok: true; session: LeadSession } | { ok: false; status: number; error: string }

const NOT_ACTIVE: { ok: false; status: number; error: string } = { ok: false, status: 404, error: 'not_active' }

// ai_coach_turns is the hosted chat's LIFETIME assistant-turn counter, read
// here so the cap is decided from the session the gate already loaded rather
// than a second query. Restart never clears it — see migration 085.
const LEAD_COLUMNS = 'id, funnel_id, email, name, first_name, status, application_status, opted_in_at, created_at, ai_coach_turns'
const FUNNEL_COLUMNS = 'id, user_id, subdomain, status, generation_id, video_url, problem_solution_label, landing_page'

// Reads the token from the Authorization bearer, ?t=, or an x-coach-token
// header — the lead-facing shell is a public page that may carry it in the URL
// on first load and in a header thereafter.
export function readCoachToken(req: any): string {
  const auth = req.headers?.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const header = req.headers?.['x-coach-token']
  if (typeof header === 'string' && header) return header
  const q = req.query?.t
  const fromQuery = Array.isArray(q) ? q[0] : q
  return typeof fromQuery === 'string' ? fromQuery : ''
}

export async function resolveLeadSession(req: any): Promise<SessionResult> {
  const decoded = verifyCoachToken(readCoachToken(req))
  if (!decoded) return NOT_ACTIVE

  const { data: lead } = await supabase.from('funnel_leads').select(LEAD_COLUMNS).eq('id', decoded.leadId).maybeSingle()
  // The token names the pair, but the binding is re-checked against the row:
  // a token whose lead has since moved (or never belonged to that funnel) is
  // not a session for it.
  if (!lead || (lead as any).funnel_id !== decoded.funnelId) return NOT_ACTIVE

  const { data: funnel } = await supabase.from('funnels').select(FUNNEL_COLUMNS).eq('id', decoded.funnelId).maybeSingle()
  if (!funnel) return NOT_ACTIVE

  const coachUserId = (funnel as any).user_id as string
  if (!coachUserId) return NOT_ACTIVE
  if (!(await hasFunnelBuilderAccess(coachUserId))) return NOT_ACTIVE

  // Activated means saved AND confirmed — a generated-but-unconfirmed draft is
  // the coach still deciding, and must not answer a lead.
  const saved = await getSavedOutput(coachUserId, 'ai_coach')
  const aiCoach = saved?.content as AICoachContent | undefined
  if (!aiCoach?.confirmed || !aiCoach.config) return NOT_ACTIVE

  return {
    ok: true,
    session: {
      leadId: decoded.leadId,
      funnelId: decoded.funnelId,
      coachUserId,
      lead: lead as Record<string, any>,
      funnel: funnel as Record<string, any>,
      aiCoach,
    },
  }
}

// Which of the coach's blueprints this lead's conversation is about.
//
// Funnel handoff first: a lead who came through a funnel is already thinking
// about THAT problem, so if the funnel's blueprint is one the bot was built on,
// it wins. Otherwise the coach's primary blueprint (card_ids[0]) — the bot can
// only speak to what it was built on, so pointing at the funnel's card when the
// bot has no context for it would be worse than starting from the primary.
export async function resolveCardId(session: LeadSession): Promise<string | null> {
  const cardIds = session.aiCoach.config.card_ids || []
  if (!cardIds.length) return null

  const generationId = session.funnel.generation_id
  if (typeof generationId === 'string' && generationId) {
    const { data: gen } = await supabase.from('mtm_generations').select('card_id').eq('id', generationId).maybeSingle()
    const funnelCardId = (gen as any)?.card_id
    if (typeof funnelCardId === 'string' && cardIds.includes(funnelCardId)) return funnelCardId
  }
  return cardIds[0]
}
