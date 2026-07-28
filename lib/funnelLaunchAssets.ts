import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getSavedOutput } from './savedOutputs'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'
import { sanitizePhrasingDeep } from './phrasing'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { SALES_FRAMEWORK_CANONICAL, OBJECTION_LOOPS } from './salesFrameworksCanonical'

// ── Growth Kit ───────────────────────────────────────────────────────────────
// Per-funnel launch assets, generated on demand one asset_type at a time and
// persisted to funnel_launch_assets (one row per funnel+type, upserted on
// regeneration). See migration 061 for the storage contract.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const FUNNEL_DOMAIN = process.env.FUNNEL_PUBLIC_DOMAIN || 'freeminiworkshop.com'

export const FUNNEL_ASSET_TYPES = [
  'invite_emails',
  'social_5day',
  'call_flow',
  'sales_script',
  'objection_scripts',
  'post_call_emails',
] as const
export type FunnelAssetType = (typeof FUNNEL_ASSET_TYPES)[number]

// The "win the call" four. These are gated on the funnel having at least one
// booking: before a call exists they are advice the coach cannot act on, and
// generating them early spends tokens on output that will likely be regenerated
// once real calls start. invite_emails and social_5day are the fill-the-calendar
// half and are always available — they are what CREATE the booking.
export const WIN_THE_CALL_TYPES: readonly FunnelAssetType[] = [
  'call_flow',
  'sales_script',
  'objection_scripts',
  'post_call_emails',
]

export function isFunnelAssetType(v: unknown): v is FunnelAssetType {
  return typeof v === 'string' && (FUNNEL_ASSET_TYPES as readonly string[]).includes(v)
}

export function isWinTheCall(t: FunnelAssetType): boolean {
  return WIN_THE_CALL_TYPES.includes(t)
}

// Asset status as the GET grid reports it (see the Growth Kit API contract):
//   ready     — content exists (or is derived on read, as invite_emails is)
//   available — nothing generated yet, but the coach can generate it now
//   locked    — a win-the-call type while the funnel has no booking
export type FunnelAssetStatus = 'ready' | 'available' | 'locked'

// The 6-Step High-Ticket call framework, per the Growth Kit contract.
//
// ⚠️ These names DIVERGE from SALES_SCRIPT_BEATS in lib/salesFrameworksCanonical.ts,
// which the Build wizard's sales_script unit already uses and persists into
// mtm_generations.sales_script. Steps 1-2 agree; 3-6 do not:
//   canonical : Help and expand / Bridge to agreement / Without a shadow of doubt / The logical next step
//   contract  : Expose opportunities / Build the bridge / Sell the movement (A→B) / Invite / ask
// The contract is declared the single source of truth for the Growth Kit, so it
// wins here — but the two surfaces now describe the same house method with
// different step names, which is a real inconsistency for a coach who sees both.
// Flagged for resolution rather than silently reconciled in either direction.
export const CALL_FLOW_STEPS = [
  'Confirm intentions',
  'Measure the gap',
  'Expose opportunities',
  'Build the bridge',
  'Sell the movement (A→B)',
  'Invite / ask',
] as const

// Angles for the 5-day social run-up, per contract.
export const SOCIAL_ANGLES = ['problem', 'story', 'authority', 'proof', 'cta'] as const

// Contract-pinned counts.
const INVITE_EMAIL_COUNT = 3
const POST_CALL_EMAIL_COUNT = 3

// ── Booking gate ─────────────────────────────────────────────────────────────
// "At least one booking" is read from BOTH signals the funnel records, because
// they can diverge: funnel_events.'booked' is the tracked event fired by the
// public booking flow, while funnel_leads.status is the coach's own CRM state
// (they can mark a lead booked/closed manually without a tracked event, and a
// lead that later closed is by definition one that booked). Either counts.
export async function funnelHasBooking(funnelId: string): Promise<boolean> {
  const [events, leads] = await Promise.all([
    supabase
      .from('funnel_events')
      .select('*', { count: 'exact', head: true })
      .eq('funnel_id', funnelId)
      .eq('event_type', 'booked'),
    supabase
      .from('funnel_leads')
      .select('*', { count: 'exact', head: true })
      .eq('funnel_id', funnelId)
      .in('status', ['booked', 'closed', 'sold']),
  ])
  return (events.count ?? 0) > 0 || (leads.count ?? 0) > 0
}

// ── Funnel URLs ──────────────────────────────────────────────────────────────
export type FunnelUrls = { base: string; training: string; booking: string }

export function funnelUrls(subdomain: string): FunnelUrls {
  const base = `https://${subdomain}.${FUNNEL_DOMAIN}`
  return { base, training: `${base}/?page=training`, booking: `${base}/?page=book` }
}

// ── Grounding ────────────────────────────────────────────────────────────────
// The same user-level intelligence the micro-training generator runs on, plus
// this funnel's own generation row. Loaded once per generate call.
export type FunnelGrounding = {
  audience: unknown
  transformation: unknown
  framework: unknown
  generation: Record<string, any> | null
  urls: FunnelUrls
}

export async function loadFunnelGrounding(
  userId: string,
  funnel: Record<string, any>
): Promise<FunnelGrounding> {
  const [audienceRow, transformationRow, frameworkRow, genRes] = await Promise.all([
    getSavedOutput(userId, 'audience'),
    getSavedOutput(userId, 'transformation_analysis'),
    getSavedOutput(userId, 'framework'),
    funnel.generation_id
      ? supabase.from('mtm_generations').select('*').eq('id', funnel.generation_id).eq('user_id', userId).maybeSingle()
      : Promise.resolve({ data: null } as any),
  ])
  return {
    audience: audienceRow?.content ?? null,
    transformation: transformationRow?.content ?? null,
    framework: frameworkRow?.content ?? null,
    generation: (genRes as any)?.data ?? null,
    urls: funnelUrls(String(funnel.subdomain || '')),
  }
}

// ── invite_emails: surface, don't rewrite ────────────────────────────────────
// The coach already approved warm-invite copy during the Build wizard. The Growth
// Kit's job is to hand them that copy pointed at THIS funnel, not to invent a
// second version that competes with it — so this is a pure derivation with no
// model call (and therefore no cost and no drift from what they approved).
const LINK_TOKENS: Array<[RegExp, keyof FunnelUrls]> = [
  [/\[TRAINING_LINK\]/g, 'training'],
  [/\[GUIDE_LINK\]/g, 'training'],
  [/\[BOOK_A_CALL_LINK\]/g, 'booking'],
  [/\[OFFER_LINK\]/g, 'booking'],
  [/\[FUNNEL_LINK\]/g, 'base'],
]

function substituteLinks(text: string, urls: FunnelUrls): string {
  let out = typeof text === 'string' ? text : ''
  for (const [re, key] of LINK_TOKENS) out = out.replace(re, urls[key])
  return out
}

export function deriveInviteEmails(g: FunnelGrounding): Record<string, unknown> {
  const raw = Array.isArray(g.generation?.warm_invite_emails) ? g.generation!.warm_invite_emails : []
  // Contract shape is exactly { emails: [{ subject, body }] }. The source rows
  // also carry email_number/send_timing; those are dropped rather than passed
  // through so the payload matches the contract byte-for-byte. Not padded when
  // the coach has fewer than 3 — inventing empty invites would be worse than
  // returning what they actually approved.
  const emails = raw.slice(0, INVITE_EMAIL_COUNT).map((e: any) => ({
    subject: substituteLinks(String(e?.subject ?? ''), g.urls),
    body: substituteLinks(String(e?.body ?? ''), g.urls),
  }))
  return { emails }
}

// ── Generated assets ─────────────────────────────────────────────────────────
const SHARED_TAIL = `Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.
Ground everything in the coach's real audience language, their transformation, and this specific offer. No generic coaching-industry filler.
${GENDER_NEUTRAL_INSTRUCTION}
${STYLE_GUIDELINES}`

function groundingMessage(g: FunnelGrounding, extra = ''): string {
  const gen = g.generation || {}
  return `AUDIENCE INTELLIGENCE: ${JSON.stringify(g.audience)}
TRANSFORMATION DATA: ${JSON.stringify(g.transformation)}
RESULTS FRAMEWORK: ${JSON.stringify(g.framework)}
THIS OFFER (the training the funnel promotes):
- title: ${JSON.stringify(gen.chosen_topic ?? '')}
- angle/hook: ${JSON.stringify(gen.chosen_angle ?? '')}
- subtitle: ${JSON.stringify(gen.subtitle ?? '')}
FUNNEL LINKS:
- landing: ${g.urls.base}
- training: ${g.urls.training}
- booking: ${g.urls.booking}${extra}

Generate now.`
}

async function callJson(userId: string, system: string, user: string, maxTokens: number): Promise<any> {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: user }],
  })
  await logApiCost(userId, 'funnel_launch_assets', 'claude-sonnet-5', message.usage.input_tokens, message.usage.output_tokens)
  const block = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  return extractJson(block?.text ?? '')
}

const SOCIAL_PROMPT = `You write a coach's 5-day social run-up to their free micro-training. Each day is one post that builds toward the training, in the audience's own language.

{
  "posts": [
    { "day": 1, "angle": "problem", "text": "the full post, 60-120 words, ready to paste — ending with the training link" }
  ]
}

Rules:
- EXACTLY 5 posts, day 1 through 5, in order.
- angle must be exactly one of ${JSON.stringify(SOCIAL_ANGLES)}, used ONCE each, in that order: day 1 problem, day 2 story, day 3 authority, day 4 proof, day 5 cta.
- Each post is a genuinely different entry point on the same offer, not five rewordings.
- Every post ends by pointing at the training link given in the grounding.
- Open each post on a CONCRETE SITUATION the reader lives or a DIRECT CLAIM. Never "it's not X, it's Y".
${SHARED_TAIL}`

const CALL_FLOW_PROMPT = `You produce the CALL FLOW a coach follows on a high-ticket implementation call: the 6-Step High-Ticket framework, filled in for THIS coach's offer and audience. This is the map of the call, not the word-for-word script.

${SALES_FRAMEWORK_CANONICAL}

{
  "steps": [
    {
      "n": 1,
      "name": "Confirm intentions",
      "goal": "what this step must accomplish before moving on, one sentence",
      "cues": ["a question or move the coach uses here", "a second"]
    }
  ]
}

Rules:
- EXACTLY 6 steps, n 1-6 in order, with names EXACTLY: ${JSON.stringify(CALL_FLOW_STEPS)}.
- cues: 2-4 per step, each a concrete thing the coach says or watches for at that moment — grounded in this offer and this audience, not generic sales advice.
- Diagnosis-first call. No pressure tactics, no manufactured scarcity.
${SHARED_TAIL}`

const SALES_SCRIPT_PROMPT = `You write the TALK TRACK for a coach's high-ticket implementation call: what they actually say at each of the 6 steps, in their voice, for this specific offer and audience.

${SALES_FRAMEWORK_CANONICAL}

{
  "steps": [
    { "n": 1, "name": "Confirm intentions", "script": "the words the coach says at this step" }
  ]
}

Rules:
- EXACTLY 6 steps, n 1-6 in order, with names EXACTLY: ${JSON.stringify(CALL_FLOW_STEPS)}.
- script is spoken language the coach can say as-is — the audience's vocabulary, this coach's voice, this offer's specifics. Not stage directions and not a description of what to cover.
- Diagnosis-first. The ask at step 6 is direct and calm, never a pressure close.
${SHARED_TAIL}`

const OBJECTION_PROMPT = `You write the OBJECTION SCRIPTS for a coach's implementation call: the REAL resistance THIS audience brings (from their captured fears, past attempts, and internal dialogue), each mapped to one Objection Loop and answered.

${SALES_FRAMEWORK_CANONICAL}

{
  "objections": [
    {
      "objection": "the objection in the PROSPECT'S own voice — what they would actually say out loud",
      "loop": "commitment",
      "response": "the words the coach says back — the actual response, not advice about responding"
    }
  ]
}

Rules:
- EXACTLY 6 objections, each rooted in a DIFFERENT specific detail from this audience's captured fears, doubts, past attempts, or internal dialogue. No interchangeable generic money/time objections.
- loop must be exactly one of ${JSON.stringify(OBJECTION_LOOPS)}. Cover at least three of the four across the set.
- response dissolves the resistance inside the call. Never a close-the-no pressure mechanic.
${SHARED_TAIL}`

const POST_CALL_PROMPT = `You write the POST-CALL follow-up emails a coach sends after a high-ticket implementation call.

{
  "emails": [
    { "subject": "the subject line", "body": "the email body in the coach's voice, 80-150 words" }
  ]
}

Rules:
- EXACTLY 3 emails, in send order, covering the three outcomes that actually happen: (1) they said yes — welcome and the next concrete step; (2) they are thinking about it — a same-day recap that reduces friction; (3) they went quiet — one warm, no-pressure re-open that leaves the door open.
- Make the intended outcome obvious from the subject and opening line, since the payload carries no separate label.
- No pressure, no manufactured scarcity, no fake deadlines.
- Where a link is needed, use the booking link from the grounding.
${SHARED_TAIL}`

// ── Dispatcher ───────────────────────────────────────────────────────────────
export async function generateFunnelAsset(
  userId: string,
  funnel: Record<string, any>,
  assetType: FunnelAssetType
): Promise<Record<string, unknown>> {
  const g = await loadFunnelGrounding(userId, funnel)

  // invite_emails is a derivation of already-approved copy — no model call.
  if (assetType === 'invite_emails') return deriveInviteEmails(g)

  const spec: Record<Exclude<FunnelAssetType, 'invite_emails'>, { prompt: string; maxTokens: number }> = {
    social_5day: { prompt: SOCIAL_PROMPT, maxTokens: 3000 },
    call_flow: { prompt: CALL_FLOW_PROMPT, maxTokens: 4000 },
    sales_script: { prompt: SALES_SCRIPT_PROMPT, maxTokens: 5000 },
    objection_scripts: { prompt: OBJECTION_PROMPT, maxTokens: 4000 },
    post_call_emails: { prompt: POST_CALL_PROMPT, maxTokens: 4000 },
  }
  const { prompt, maxTokens } = spec[assetType]
  const parsed = await callJson(userId, prompt, groundingMessage(g), maxTokens)

  // Same phrasing hygiene every other generator gets (strips em-dash clause splits).
  return sanitizePhrasingDeep(parsed && typeof parsed === 'object' ? parsed : {})
}

// ── Persistence ──────────────────────────────────────────────────────────────
export type FunnelLaunchAssetRow = {
  asset_type: FunnelAssetType
  content: Record<string, unknown>
  generated_at: string
}

export async function listFunnelAssets(funnelId: string): Promise<FunnelLaunchAssetRow[]> {
  const { data, error } = await supabase
    .from('funnel_launch_assets')
    .select('asset_type, content, generated_at')
    .eq('funnel_id', funnelId)
  if (error) throw error
  return (data || []) as FunnelLaunchAssetRow[]
}

export async function upsertFunnelAsset(
  funnelId: string,
  assetType: FunnelAssetType,
  content: Record<string, unknown>
): Promise<FunnelLaunchAssetRow> {
  const { data, error } = await supabase
    .from('funnel_launch_assets')
    .upsert(
      { funnel_id: funnelId, asset_type: assetType, content, generated_at: new Date().toISOString() },
      { onConflict: 'funnel_id,asset_type' }
    )
    .select('asset_type, content, generated_at')
    .single()
  if (error) throw error
  return data as FunnelLaunchAssetRow
}

// ── Grid assembly (contract GET shape) ───────────────────────────────────────
// invite_emails is derived on READ and therefore always 'ready' — it is never
// persisted, so it can never go stale against the coach's approved warm invites.
// Everything else is 'ready' when a row exists, 'available' when it does not, and
// 'locked' when it is a win-the-call type and the funnel has no booking yet.
export function assetStatus(
  assetType: FunnelAssetType,
  hasContent: boolean,
  winTheCallUnlocked: boolean
): FunnelAssetStatus {
  if (assetType === 'invite_emails') return 'ready'
  if (isWinTheCall(assetType) && !winTheCallUnlocked) return 'locked'
  return hasContent ? 'ready' : 'available'
}
