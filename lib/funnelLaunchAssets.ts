import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getSavedOutput } from './savedOutputs'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'
import { sanitizePhrasingDeep } from './phrasing'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { SALES_FRAMEWORK_CANONICAL, SALES_SCRIPT_BEATS } from './salesFrameworksCanonical'

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

// Which assets are DERIVED from what the coach already built vs GENERATED fresh.
//
// Derived assets pass the coach's stored mtm_generations values through verbatim
// with no model call, so the funnel shows the exact script/objections/invites the
// coach approved in the Build wizard. They cannot drift, cost nothing, and are
// always available — there is nothing to "generate".
export const DERIVED_TYPES: readonly FunnelAssetType[] = ['invite_emails', 'sales_script', 'objection_scripts']

// Generated fresh, and gated on the funnel having at least one booking. Only
// these two remain gated: before a call exists they are advice the coach cannot
// act on, and generating them early spends tokens on output that will likely be
// redone once real calls start. social_5day generates fresh but is NOT gated —
// it is part of what CREATES the first booking.
export const GATED_TYPES: readonly FunnelAssetType[] = ['call_flow', 'post_call_emails']

export function isFunnelAssetType(v: unknown): v is FunnelAssetType {
  return typeof v === 'string' && (FUNNEL_ASSET_TYPES as readonly string[]).includes(v)
}

export function isDerived(t: FunnelAssetType): boolean {
  return DERIVED_TYPES.includes(t)
}

export function isGated(t: FunnelAssetType): boolean {
  return GATED_TYPES.includes(t)
}

// Asset status as the GET grid reports it (see the Growth Kit API contract):
//   ready     — content exists, or is derived on read from the coach's own build
//   available — nothing generated yet, but the coach can generate it now
//   locked    — a generated+gated type while the funnel has no booking
export type FunnelAssetStatus = 'ready' | 'available' | 'locked'

// The call framework's step names + order come VERBATIM from SALES_SCRIPT_BEATS
// in lib/salesFrameworksCanonical.ts — the single source of truth for the sales
// method, and the same constant the Build wizard's Script step already runs on.
// Grounding both surfaces on that one constant makes them agree by construction:
// a change to the method is a change to that file, with no code change here.
//
// Deliberately NOT redeclared as a local list. An earlier revision hardcoded the
// older sales-frameworks-canonical.md step names, which silently disagreed with
// the .ts the Build already used; re-deriving from the constant removes the class
// of bug rather than just fixing the values.

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

// ── sales_script / objection_scripts: derive, don't regenerate ───────────────
// The Build wizard already generated these on SALES_SCRIPT_BEATS and the coach
// may have edited them. Regenerating would produce a SECOND, different script for
// the same offer; deriving guarantees the funnel shows the exact one they built.
// No model call, so there is no cost and no drift — same contract as invite_emails.
//
// Text is passed through VERBATIM. The stored rows are richer than the contract
// shape ({ beat, prospect_mindset, phrasing_options[], recommended } per beat;
// { objection, handling, loop } per objection), so this maps rather than reshapes:
// no wording is rewritten, only the field names and the subset the contract
// declares. See the note in the PR about the fields the v1 contract has no slot
// for (prospect_mindset / phrasing_options).
export function deriveSalesScript(g: FunnelGrounding): Record<string, unknown> {
  const raw = Array.isArray(g.generation?.sales_script) ? g.generation!.sales_script : []
  const steps = raw
    .map((b: any, i: number) => ({
      n: i + 1,
      // The beat name the coach's own script carries — already one of
      // SALES_SCRIPT_BEATS, since the Build generator enforced that set.
      name: String(b?.beat ?? ''),
      // `recommended` is the coach's default line for the beat: the words they
      // chose to say. Verbatim, never regenerated.
      script: String(b?.recommended ?? ''),
    }))
    .filter((st: { name: string; script: string }) => st.name.trim().length > 0 || st.script.trim().length > 0)
  return { steps }
}

export function deriveObjectionScripts(g: FunnelGrounding): Record<string, unknown> {
  const raw = Array.isArray(g.generation?.objections) ? g.generation!.objections : []
  const objections = raw
    .map((o: any) => ({
      objection: String(o?.objection ?? ''),
      // Loop keys already come from OBJECTION_LOOPS in the canonical .ts.
      loop: String(o?.loop ?? ''),
      // Stored as `handling`; the contract calls it `response`. Rename only.
      response: String(o?.handling ?? ''),
    }))
    .filter((o: { objection: string; response: string }) => o.objection.trim().length > 0 || o.response.trim().length > 0)
  return { objections }
}

// Derive one asset from an ALREADY-LOADED grounding. Lets the read path resolve
// all three derived types from a single grounding load instead of re-querying per
// type. Returns null for a type that is generated rather than derived.
export function deriveAsset(g: FunnelGrounding, assetType: FunnelAssetType): Record<string, unknown> | null {
  switch (assetType) {
    case 'invite_emails':
      return deriveInviteEmails(g)
    case 'sales_script':
      return deriveSalesScript(g)
    case 'objection_scripts':
      return deriveObjectionScripts(g)
    default:
      return null
  }
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
      "name": "${SALES_SCRIPT_BEATS[0]}",
      "goal": "what this step must accomplish before moving on, one sentence",
      "cues": ["a question or move the coach uses here", "a second"]
    }
  ]
}

Rules:
- EXACTLY ${SALES_SCRIPT_BEATS.length} steps, n 1-${SALES_SCRIPT_BEATS.length} in order, with names EXACTLY: ${JSON.stringify(SALES_SCRIPT_BEATS)}.
- cues: 2-4 per step, each a concrete thing the coach says or watches for at that moment — grounded in this offer and this audience, not generic sales advice.
- Diagnosis-first call. No pressure tactics, no manufactured scarcity.
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

  // Derived assets pass the coach's own build through verbatim — no model call.
  const derived = deriveAsset(g, assetType)
  if (derived) return derived

  // Only the three generated types have prompts; the derived ones returned above.
  // Partial + an explicit guard rather than a cast, so adding a new asset type
  // without a prompt fails loudly here instead of dereferencing undefined.
  const spec: Partial<Record<FunnelAssetType, { prompt: string; maxTokens: number }>> = {
    social_5day: { prompt: SOCIAL_PROMPT, maxTokens: 3000 },
    call_flow: { prompt: CALL_FLOW_PROMPT, maxTokens: 4000 },
    post_call_emails: { prompt: POST_CALL_PROMPT, maxTokens: 4000 },
  }
  const entry = spec[assetType]
  if (!entry) throw new Error(`No generator for asset_type "${assetType}"`)
  const { prompt, maxTokens } = entry
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
  // Derived assets are computed on read from what the coach already built, so
  // they are always present and never gated.
  if (isDerived(assetType)) return 'ready'
  if (isGated(assetType) && !winTheCallUnlocked) return 'locked'
  return hasContent ? 'ready' : 'available'
}
