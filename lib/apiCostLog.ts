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
