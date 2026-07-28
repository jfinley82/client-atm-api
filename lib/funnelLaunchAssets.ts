import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getSavedOutput } from './savedOutputs'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'
import { sanitizePhrasingDeep } from './phrasing'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { SALES_FRAMEWORK_CANONICAL, SALES_SCRIPT_BEATS, OBJECTION_LOOPS } from './salesFrameworksCanonical'

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
  const emails = raw.map((e: any, i: number) => ({
    email_number: typeof e?.email_number === 'number' ? e.email_number : i + 1,
    send_timing: typeof e?.send_timing === 'string' ? e.send_timing : '',
    subject: substituteLinks(String(e?.subject ?? ''), g.urls),
    body: substituteLinks(String(e?.body ?? ''), g.urls),
  }))
  return {
    // Flagged so the UI can say "these are your approved invites" rather than
    // presenting them as freshly written copy.
    source: 'warm_invite_emails',
    funnel_url: g.urls.base,
    training_url: g.urls.training,
    booking_url: g.urls.booking,
    emails,
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

const SOCIAL_PROMPT = `You write a coach's 5-day social run-up to a free micro-training. Each day is one post that builds toward the training, in the audience's own language.

{
  "days": [
    {
      "day": 1,
      "theme": "what this day's post is doing in the run-up (e.g. name the problem, agitate the cost, tease the shift, proof, final call)",
      "hook": "the opening line — a concrete situation or a direct claim, never a negation-then-reframe",
      "body": "the post body, 60-120 words, in the coach's voice and the audience's language",
      "cta": "the closing line inviting them to the training, with the training link"
    }
  ]
}

Rules:
- EXACTLY 5 entries, day 1-5, each a genuinely different angle on the same offer — not five rewordings.
- Day 5 is the final call before the training; it should carry the most urgency without inventing fake scarcity.
- Every cta references the training link provided in the grounding.
- Hooks: a CONCRETE SITUATION the reader lives, or a DIRECT CLAIM. Never "it's not X, it's Y".
${SHARED_TAIL}`

const CALL_FLOW_PROMPT = `You produce the CALL FLOW a coach follows on an implementation call: the shape of the conversation beat by beat, what each beat is for, and what to watch for. This is the map, not the word-for-word script.

${SALES_FRAMEWORK_CANONICAL}

{
  "beats": [
    {
      "beat": "the beat name, exactly as given in the methodology",
      "goal": "what this beat must accomplish before moving on, in one sentence",
      "prompts": ["a question or move the coach uses here", "a second", "a third"],
      "watch_for": "the signal that says move on — or that says stay here"
    }
  ]
}

Rules:
- One entry per beat, in order, using EXACTLY these beat names: ${JSON.stringify(SALES_SCRIPT_BEATS)}.
- Ground every beat in THIS coach's offer and audience — the prompts should sound like this coach talking to this specific person.
- This is a diagnosis-first call, never a pitch. No pressure tactics.
${SHARED_TAIL}`

const SALES_SCRIPT_PROMPT = `You write the word-for-word SALES SCRIPT for a coach's implementation call, following the house methodology below.

${SALES_FRAMEWORK_CANONICAL}

{
  "beats": [
    {
      "beat": "the beat name, exactly as given in the methodology",
      "prospect_mindset": "where the prospect's head is at this moment in the call",
      "phrasing_options": ["a line the coach could say here, in their voice", "a second, genuinely different option"],
      "recommended": "the single best line to default to"
    }
  ]
}

Rules:
- One entry per beat, in order, using EXACTLY these beat names: ${JSON.stringify(SALES_SCRIPT_BEATS)}.
- phrasing_options: 2-3 per beat, genuinely distinct, all in the coach's voice and the audience's language.
- recommended must be one of the phrasing_options or a sharpened version of the strongest.
${SHARED_TAIL}`

const OBJECTION_PROMPT = `You write the OBJECTION SCRIPTS for a coach's implementation call: the specific resistance THIS audience brings, and how to handle each inside the house methodology.

${SALES_FRAMEWORK_CANONICAL}

{
  "objections": [
    {
      "objection": "the objection in the PROSPECT'S own voice — what they'd actually say out loud",
      "loop": "which of the four loops this is",
      "beneath_it": "what is actually driving it, one sentence",
      "handling": "how the coach handles it — the actual words, not advice about handling it"
    }
  ]
}

Rules:
- EXACTLY 6 objections, each drawn from a DIFFERENT specific detail of this audience's fears, past attempts, or internal dialogue. No interchangeable generic money/time objections.
- loop must be exactly one of: ${JSON.stringify(OBJECTION_LOOPS)}. Cover at least three of the four across the set.
- handling is proactive dissolution inside the call, never a close-the-no pressure mechanic.
${SHARED_TAIL}`

const POST_CALL_PROMPT = `You write the POST-CALL follow-up emails a coach sends after an implementation call, covering the real outcomes a call can end on.

${SALES_FRAMEWORK_CANONICAL}

{
  "emails": [
    {
      "email_number": 1,
      "scenario": "which outcome this email is for: 'signed', 'thinking_about_it', 'not_now', or 'no_show'",
      "send_timing": "when to send it, in plain words (e.g. 'within an hour of the call')",
      "subject": "the subject line",
      "body": "the email body in the coach's voice, 80-150 words"
    }
  ]
}

Rules:
- EXACTLY 5 emails covering: one for 'signed' (welcome + next step), two for 'thinking_about_it' (a same-day recap and a later nudge), one for 'not_now' (keep the relationship, no pressure), one for 'no_show' (warm re-book invite).
- The 'thinking_about_it' and 'not_now' emails must NOT apply pressure or manufacture scarcity; they reduce friction and leave the door open.
- Where a link is needed use the booking link from the grounding.
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
