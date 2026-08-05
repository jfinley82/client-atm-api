import { supabase } from './supabase'

// Per-model pricing, confirmed directly from Anthropic's own pricing
// documentation (platform.claude.com/docs/en/about-claude/pricing) on
// 2026-07-09 — NOT from memory. Anthropic prices per model can and do change
// on a scheduled date (Claude Sonnet 5 specifically has a confirmed,
// documented increase), so this is a per-model TIER LIST ordered by
// effective date, not a single static number — a static number would go
// silently wrong the moment a scheduled change takes effect. Add new tiers
// here as Anthropic announces them; do not just edit the number in place.
type PricingTier = {
  effectiveFrom: string // ISO date the tier starts applying (inclusive)
  inputPerMTok: number  // USD per 1,000,000 input tokens
  outputPerMTok: number // USD per 1,000,000 output tokens
}

const PRICING: Record<string, PricingTier[]> = {
  'claude-sonnet-5': [
    // Introductory pricing, in effect from the model's launch.
    { effectiveFrom: '2026-06-30', inputPerMTok: 2, outputPerMTok: 10 },
    // Standard pricing takes effect September 1, 2026 — confirmed from
    // Anthropic's pricing docs (documented in advance, not speculative).
    { effectiveFrom: '2026-09-01', inputPerMTok: 3, outputPerMTok: 15 },
  ],
}

// Finds the tier whose effectiveFrom is the latest one <= `at`. Falls back to
// the earliest tier if `at` predates every tier (shouldn't happen in
// practice, but never silently uses a $0 rate for a KNOWN model just because
// of a clock/timezone edge case).
function resolvePricing(model: string, at: Date): { inputPerMTok: number; outputPerMTok: number } | null {
  const tiers = PRICING[model]
  if (!tiers || tiers.length === 0) return null
  const applicable = tiers.filter((t) => new Date(t.effectiveFrom).getTime() <= at.getTime())
  const tier = applicable.length > 0 ? applicable[applicable.length - 1] : tiers[0]
  return { inputPerMTok: tier.inputPerMTok, outputPerMTok: tier.outputPerMTok }
}

// Rounded to 6 decimal places — at low per-call token counts the cost is
// fractions of a cent, and truncating to 2 decimals would silently zero out
// real (if tiny) per-call costs before they ever get summed.
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number, at: Date = new Date()): number {
  const pricing = resolvePricing(model, at)
  if (!pricing) {
    // Unknown model: do NOT guess a rate. A fabricated plausible-looking
    // number is worse than an obvious $0 — this makes a pricing-table gap
    // immediately visible in the log instead of quietly wrong.
    console.error(`[apiCostLog] no pricing entry for model "${model}" — logging cost as $0, add it to PRICING in lib/apiCostLog.ts`)
    return 0
  }
  const cost = (inputTokens / 1_000_000) * pricing.inputPerMTok + (outputTokens / 1_000_000) * pricing.outputPerMTok
  return round6(cost)
}

// Shared so the cache-token surcharge below rounds identically to the base cost
// rather than at a different precision.
function round6(cost: number): number {
  return Math.round(cost * 1_000_000) / 1_000_000
}

// Best-effort, non-blocking telemetry: a failure to log cost must never break
// the actual user-facing generation call it's measuring. Errors are logged,
// never thrown. Called immediately after the Anthropic response is received
// (before parsing/extractJson) at every call site, so a call that fails to
// parse as valid JSON downstream is still logged accurately — Anthropic
// billed for it either way.
/**
 * Prompt-cache token counts for a call that used cache_control.
 *
 * These are billed at MULTIPLES of the base input rate, and Anthropic reports
 * them SEPARATELY from `usage.input_tokens` — a cached call's input_tokens
 * counts only the uncached remainder. Passing them through is what keeps
 * cost_usd true and what makes a hit distinguishable from a miss afterwards:
 * cache_read > 0 is a hit, cache_creation > 0 is a miss that just populated it.
 */
export type CacheUsage = {
  creationInputTokens?: number
  readInputTokens?: number
  /** Write multiplier differs by TTL: 5m is 1.25x base input, 1h is 2x. */
  ttl?: '5m' | '1h'
}

// Anthropic's published cache multipliers, relative to the model's base input
// rate. Reads are the whole point: a tenth of base.
const CACHE_WRITE_MULTIPLIER: Record<'5m' | '1h', number> = { '5m': 1.25, '1h': 2 }
const CACHE_READ_MULTIPLIER = 0.1

export async function logApiCost(
  userId: string,
  toolType: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: CacheUsage
): Promise<void> {
  try {
    const cacheCreation = Math.max(0, Math.round(cache?.creationInputTokens ?? 0))
    const cacheRead = Math.max(0, Math.round(cache?.readInputTokens ?? 0))

    let cost_usd = computeCostUsd(model, inputTokens, outputTokens)
    if (cacheCreation > 0 || cacheRead > 0) {
      const pricing = resolvePricing(model, new Date())
      if (pricing) {
        const perToken = pricing.inputPerMTok / 1_000_000
        const writeMultiplier = CACHE_WRITE_MULTIPLIER[cache?.ttl ?? '5m']
        cost_usd = round6(
          cost_usd + cacheCreation * perToken * writeMultiplier + cacheRead * perToken * CACHE_READ_MULTIPLIER
        )
      }
    }

    const { error } = await supabase.from('api_cost_log').insert({
      user_id: userId,
      tool_type: toolType,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      cost_usd,
    })
    if (error) console.error('[apiCostLog] insert failed', error)
  } catch (err) {
    console.error('[apiCostLog] logApiCost threw', err)
  }
}

// Log a non-token, non-metered event to the same api_cost_log sink for volume
// telemetry (e.g. a transactional email send). Cost is $0 by definition, so there
// is NO pricing lookup — unlike logApiCost, this never emits the "no pricing
// entry" warning for a sender that isn't an LLM. Same best-effort, never-throws
// contract; the admin dashboard aggregates cost_usd by tool_type either way.
export async function logEvent(userId: string, toolType: string, source = 'n/a'): Promise<void> {
  try {
    const { error } = await supabase.from('api_cost_log').insert({
      user_id: userId,
      tool_type: toolType,
      model: source,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    })
    if (error) console.error('[apiCostLog] insert failed', error)
  } catch (err) {
    console.error('[apiCostLog] logEvent threw', err)
  }
}

// Groq Whisper transcription is billed per hour of audio, not per token, so
// it needs its own pricing table and resolver rather than reusing PRICING/
// computeCostUsd above — same api_cost_log sink, different unit.
//
// Rates are Groq's PUBLIC LIST prices (confirmed by Jamaul from Groq's
// published pricing, 2026-07-15) — the account's own console tier is the
// authoritative number and a free tier may actually bill $0, so treat these
// logged costs as a list-price ceiling, not an invoice. Groq bills a
// 10-second minimum per request regardless of actual audio length
// (BILLING_MIN_SECONDS below).
//
// If cost ever matters: whisper-large-v3-turbo is $0.04/hr (~2.8x cheaper,
// marginal quality difference) — but that's a model switch in
// api/transcribe.ts's GROQ_MODEL plus a new entry here, not just a price edit.
type AudioPricingTier = {
  effectiveFrom: string // ISO date the tier starts applying (inclusive)
  ratePerHourUsd: number
}

const AUDIO_PRICING: Record<string, AudioPricingTier[]> = {
  'whisper-large-v3': [{ effectiveFrom: '2026-07-15', ratePerHourUsd: 0.111 }],
}

const BILLING_MIN_SECONDS = 10

function resolveAudioPricing(model: string, at: Date): number | null {
  const tiers = AUDIO_PRICING[model]
  if (!tiers || tiers.length === 0) return null
  const applicable = tiers.filter((t) => new Date(t.effectiveFrom).getTime() <= at.getTime())
  const tier = applicable.length > 0 ? applicable[applicable.length - 1] : tiers[0]
  return tier.ratePerHourUsd
}

export function computeAudioCostUsd(model: string, durationSeconds: number, at: Date = new Date()): number {
  const ratePerHour = resolveAudioPricing(model, at)
  if (ratePerHour === null) {
    console.error(`[apiCostLog] no pricing entry for audio model "${model}" — logging cost as $0, add it to AUDIO_PRICING in lib/apiCostLog.ts`)
    return 0
  }
  // Groq bills max(actual, 10s) per request — a 3-second clip costs the same
  // as a 10-second one, so the log reflects that rather than undercounting
  // short recordings.
  const billedSeconds = Math.max(BILLING_MIN_SECONDS, durationSeconds)
  const cost = (billedSeconds / 3600) * ratePerHour
  return Math.round(cost * 1_000_000) / 1_000_000
}

// Same best-effort, non-blocking, never-throws contract as logApiCost.
// input_tokens/output_tokens are stored as 0 — inapplicable to audio billing,
// and api-costs.ts's admin dashboard only ever aggregates cost_usd by
// tool_type, never those columns, so this doesn't skew anything it reads.
export async function logAudioCost(
  userId: string,
  toolType: string,
  model: string,
  durationSeconds: number
): Promise<void> {
  try {
    const cost_usd = computeAudioCostUsd(model, durationSeconds)
    const { error } = await supabase.from('api_cost_log').insert({
      user_id: userId,
      tool_type: toolType,
      model,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd,
    })
    if (error) console.error('[apiCostLog] insert failed', error)
  } catch (err) {
    console.error('[apiCostLog] logAudioCost threw', err)
  }
}
