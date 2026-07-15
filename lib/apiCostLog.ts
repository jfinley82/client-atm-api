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
  return Math.round(cost * 1_000_000) / 1_000_000
}

// Best-effort, non-blocking telemetry: a failure to log cost must never break
// the actual user-facing generation call it's measuring. Errors are logged,
// never thrown. Called immediately after the Anthropic response is received
// (before parsing/extractJson) at every call site, so a call that fails to
// parse as valid JSON downstream is still logged accurately — Anthropic
// billed for it either way.
export async function logApiCost(
  userId: string,
  toolType: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  try {
    const cost_usd = computeCostUsd(model, inputTokens, outputTokens)
    const { error } = await supabase.from('api_cost_log').insert({
      user_id: userId,
      tool_type: toolType,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd,
    })
    if (error) console.error('[apiCostLog] insert failed', error)
  } catch (err) {
    console.error('[apiCostLog] logApiCost threw', err)
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
