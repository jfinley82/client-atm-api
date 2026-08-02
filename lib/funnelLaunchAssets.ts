import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getSavedOutput } from './savedOutputs'
import { extractJson } from './aiJson'
import { logApiCost } from './apiCostLog'
import { sanitizePhrasingDeep } from './phrasing'
import { GENDER_NEUTRAL_INSTRUCTION, STYLE_GUIDELINES } from './promptGuidelines'
import { getVoiceContext } from './voiceGuide'
import { SALES_FRAMEWORK_CANONICAL, SALES_SCRIPT_BEATS } from './salesFrameworksCanonical'
import { BlueprintSynopsis } from './blueprintSynopsis'

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
  'one_pager',
  'price_value',
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

// ── Offer grounding (one_pager / price_value) ───────────────────────────────
// The offer these two "Frame the offer" tools describe: the account-level
// high-ticket offer's NAME (lib/coreOffersAnalysis.ts's CoreOffer, via the
// core_offers saved output) and THIS funnel's own configured PRICE
// (funnels.offer_price_display — a per-funnel field, since one account can run
// several funnels at different price points). The synopsis is the same
// problem/solution conviction data (offer_includes, transformation,
// cost_of_inaction, solution_summary, audience_quote, objection_dissolved,
// teaching_outline) already resolved onto problem_solution_cards.synopsis for
// this funnel's blueprint card by the existing lazy-synopsis path
// (lib/blueprintEnrichment.ts) — read here, never regenerated: if a card was
// never viewed through /api/my-micro-trainings or /api/micro-blueprints/results
// and so has no synopsis yet, that's a real "not ready" state, not something
// this endpoint should trigger a second generation pipeline to fill.
export class LaunchAssetNotReadyError extends Error {
  missing: ('offer' | 'synopsis')[]
  constructor(missing: ('offer' | 'synopsis')[]) {
    super(`launch asset not ready: missing ${missing.join(', ')}`)
    this.missing = missing
  }
}

export type OfferGrounding = {
  ready: boolean
  missing: ('offer' | 'synopsis')[]
  offerName: string
  price: string
  synopsis: BlueprintSynopsis | null
}

export async function loadOfferGrounding(
  userId: string,
  funnel: Record<string, any>,
  g: FunnelGrounding
): Promise<OfferGrounding> {
  const cardId = typeof g.generation?.card_id === 'string' ? g.generation.card_id : null
  const [coreOffersRow, cardRes] = await Promise.all([
    getSavedOutput(userId, 'core_offers'),
    cardId
      ? supabase.from('problem_solution_cards').select('synopsis').eq('id', cardId).maybeSingle()
      : Promise.resolve({ data: null } as any),
  ])

  const highTicket = (coreOffersRow?.content as { high_ticket?: { name?: unknown } } | undefined)?.high_ticket
  const offerName = typeof highTicket?.name === 'string' ? highTicket.name.trim() : ''
  const price = typeof funnel.offer_price_display === 'string' ? funnel.offer_price_display.trim() : ''
  const synopsis = ((cardRes as any)?.data?.synopsis ?? null) as BlueprintSynopsis | null

  const missing: ('offer' | 'synopsis')[] = []
  if (!offerName || !price) missing.push('offer')
  if (!synopsis) missing.push('synopsis')

  return { ready: missing.length === 0, missing, offerName, price, synopsis }
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
      // Additive per the go-live fix list, so the Growth Kit can render the beat
      // exactly as the Build/Launch renderer does rather than showing only the
      // default line. Both are stored on every beat; passed through verbatim.
      prospect_mindset: String(b?.prospect_mindset ?? ''),
      phrasing_options: Array.isArray(b?.phrasing_options)
        ? b.phrasing_options.map((o: unknown) => String(o ?? ''))
        : [],
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
      // NOTE: the go-live fix list also asked for `beneath_it` here. The Build
      // never generated or stored that field (stored objections are exactly
      // { objection, handling, loop }), so there is nothing to derive it from —
      // emitting it would mean inventing text, which is precisely what "derive,
      // don't regenerate" rules out. Omitted deliberately; flagged for the
      // frontend so it does not wait on a field that will never arrive.
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

// one_pager / price_value need the coach's voice guide layered on the shared
// style rules (STYLE_GUIDELINES) when one exists, same as other app-generated
// marketing copy (lib/voiceGuide.ts's getVoiceContext) — the sibling generators
// above don't use a voice guide today, so this is scoped to these two only
// rather than changing SHARED_TAIL's fallback-only behavior for everyone else.
async function voiceAwareTail(userId: string): Promise<string> {
  return `Output ONLY valid JSON, no preamble, no markdown, no code fences. Double quotes only.
Ground everything in the coach's real audience language, their transformation, and this specific offer. No generic coaching-industry filler.
${GENDER_NEUTRAL_INSTRUCTION}
${await getVoiceContext(userId)}`
}

// Appended to groundingMessage()'s `extra` for one_pager/price_value — the
// HIGH-TICKET offer's name + this funnel's own price, plus the full
// problem/solution synopsis (see OfferGrounding above). Labeled distinctly from
// groundingMessage's own "THIS OFFER" section, which describes the free
// training, not the paid offer these two tools frame.
function offerGroundingBlock(offer: OfferGrounding): string {
  return `
HIGH-TICKET OFFER:
- name: ${JSON.stringify(offer.offerName)}
- price: ${JSON.stringify(offer.price)}
PROBLEM/SOLUTION SYNOPSIS: ${JSON.stringify(offer.synopsis)}`
}

const ONE_PAGER_PROMPT = `You write the ONE-PAGER for a coach's high-ticket offer — a single page a lead can read in under a minute that makes the offer's value and fit obvious. Ground every line in the HIGH-TICKET OFFER and PROBLEM/SOLUTION SYNOPSIS below — never generic coaching-industry copy.

{
  "who_its_for": "one short paragraph — the specific person this offer is for, in their own language (drawn from the synopsis's audience_quote)",
  "what_you_get": "one short paragraph — the concrete components of the offer, stated plainly (drawn from the synopsis's offer_includes)",
  "the_outcome": "one short paragraph — the transformation this offer produces (drawn from the synopsis's transformation and cost_of_inaction)",
  "said_plainly": "one or two sentences — the offer stated as plainly and honestly as possible, the way the coach would explain it to a friend, not a sales pitch"
}

Rules:
- Each paragraph is 2-4 sentences, concrete and specific to this offer/audience — never generic.
- Do NOT state the offer's name or price anywhere in your output — those are supplied separately and merged in verbatim.
- No hype, no fake urgency, no invented specifics beyond what the synopsis and offer provide.`

const PRICE_VALUE_PROMPT = `You write the PRICE & VALUE moment of a coach's live 1:1 call for their high-ticket offer — three beats: stack the value already established, state the price plainly, then hold the silence. Ground every line in the HIGH-TICKET OFFER and PROBLEM/SOLUTION SYNOPSIS below.

{
  "beats": [
    { "n": 1, "name": "Stack the value", "goal": "one line — what this beat must accomplish before the price is said", "script": "the word-for-word talk track the coach says out loud" },
    { "n": 2, "name": "State the price", "goal": "one line — what this beat must accomplish", "script": "the word-for-word talk track" },
    { "n": 3, "name": "Hold it", "goal": "one line — what this beat must accomplish", "script": "the word-for-word talk track" }
  ]
}

Rules:
- EXACTLY 3 beats, in this order, with names EXACTLY "Stack the value", "State the price", "Hold it".
- Stack the value: recap what's included and the transformation it produces (drawn from the synopsis's offer_includes / transformation / solution_summary) so the price lands against value already established, not cold.
- State the price: state the ACTUAL price from the HIGH-TICKET OFFER above, plainly and without flinching — no discounting language, no apology, no softening it with a range.
- Hold it: a short line that states the price then stops — coach the coach to go silent, not fill it. If it addresses a hesitation, ground it in the synopsis's objection_dissolved.
- The prospect is a REAL person whose name we do not know: use a neutral address or a bracketed [name] placeholder in script text — never a fabricated or persona name — the exact convention this coach's own sales call script already uses.
- Warm, plain, specific to this offer/audience. No pressure tactics, no manufactured scarcity, no fake urgency.`

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

  // one_pager / price_value need offer + synopsis grounding the other three
  // generated types don't, and gate on that grounding actually being present —
  // "not ready" (same actionable state POST /api/funnels/[id]/publish returns
  // when its own inputs are missing), not a generation attempted against an
  // invented offer.
  if (assetType === 'one_pager' || assetType === 'price_value') {
    const offer = await loadOfferGrounding(userId, funnel, g)
    if (!offer.ready) throw new LaunchAssetNotReadyError(offer.missing)

    const system = `${assetType === 'one_pager' ? ONE_PAGER_PROMPT : PRICE_VALUE_PROMPT}\n${await voiceAwareTail(userId)}`
    const parsed = await callJson(userId, system, groundingMessage(g, offerGroundingBlock(offer)), 3000)
    const cleaned = sanitizePhrasingDeep(parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>

    if (assetType === 'one_pager') {
      // offer_name/price are deterministic facts, not model output — spread
      // FIRST then override, so these two always win even if the model ignored
      // the "don't include them" instruction and emitted its own version.
      return { ...cleaned, offer_name: offer.offerName, price: offer.price }
    }
    return cleaned
  }

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
