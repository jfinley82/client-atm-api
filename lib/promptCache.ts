import Anthropic from '@anthropic-ai/sdk'

// ── Prompt caching: shared request builder ───────────────────────────────────
// Centralizes cache-breakpoint placement so every generator inherits the same
// layout. Anthropic caches by PREFIX: a request reads from cache only when every
// byte before the breakpoint is identical to a previous request's. So the rule
// this module enforces is stable-content-first, and a cached block must never
// have a per-call value interpolated into it.
//
// The layout, in prefix order:
//   1. system[0]  — the generator's stable preamble (its full instruction +
//      canonical rule blocks). Compile-time constant, identical for EVERY coach
//      and every call of that generator. Breakpoint here, 1h TTL.
//   2. system[1..] — per-coach voice guide (uncached; stable per coach, so it
//      still sits inside the next breakpoint's prefix).
//   3. user[0]    — the reused per-coach context (audience / transformation /
//      framework / core_offers). Breakpoint here, 5m TTL.
//   4. user[1]    — everything per-call: the blueprint card, delivery details,
//      the chosen angle, coach inputs, the ask. Never cached, full price.
//
// NOTE ON ORDERING — this codebase was already stable-first, so nothing is
// reordered here. Each generator's system prompt interpolates only module-level
// constants (SHARED_RULES, the canonical blocks, HOOK_STYLE_REMINDER), which makes
// it a byte-identical prefix across all coaches already, and buildGrounding
// already emits per-coach context before the per-card tail. Adding breakpoints is
// therefore output-neutral: cache_control changes only what the API reuses, never
// the tokens the model sees. Reordering to hoist a smaller "universal core" ahead
// of each generator's canonical blocks would cache FEWER tokens (the 1-4k canonical
// blocks would fall after the breakpoint and be paid in full every call) while also
// perturbing the prompt, so it is deliberately not done.

export type CacheTtl = '5m' | '1h'

// The 1h TTL is what makes this worth doing. Each generator's preamble is distinct,
// so there is no reuse WITHIN a build (the units run once each); the reuse is
// across builds and across coaches. A 5m window rarely spans two builds, while a
// 1h window reliably does — so 5m-only would mostly write entries that are never
// read, which costs 1.25x instead of saving.
//
// It rides an extended-cache-ttl beta that SDK 0.52.x does not type. If the
// account is not entitled, the API rejects the request and generation breaks — so
// there is an env kill-switch to fall back to the universally-supported 5m TTL
// without a redeploy. Set PROMPT_CACHE_1H=false to disable.
const ONE_HOUR_ENABLED = process.env.PROMPT_CACHE_1H !== 'false'

// Beta header required for `ttl: '1h'`. Harmless when the 1h path is off.
export const CACHE_BETA_HEADER = 'extended-cache-ttl-2025-04-11'

// Anthropic client preconfigured for prompt caching. Generators should use this
// rather than constructing their own, so the beta header and any future
// cache-related client config stay in one place.
export function createCachingClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    ...(ONE_HOUR_ENABLED ? { defaultHeaders: { 'anthropic-beta': CACHE_BETA_HEADER } } : {}),
  })
}

// Anthropic's own minimum cacheable prefix for Sonnet-class models. A block below
// this is silently NOT cached, so we skip the breakpoint rather than emit a
// no-op one (each request may carry at most 4).
export const MIN_CACHEABLE_TOKENS = 1024

// Deliberately rough: ~3.7 chars/token for English prose. Only ever used to decide
// whether a block clears the minimum, never for billing (real counts come back on
// the response's usage object), so an approximation is the right tool.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.7)
}

export function isCacheable(text: string): boolean {
  return estimateTokens(text) >= MIN_CACHEABLE_TOKENS
}

// The SDK's CacheControlEphemeral is `{ type: 'ephemeral' }` with no ttl field, so
// the 1h variant is cast. The wire format accepts the extra key; the cast is
// confined to this one function.
function cacheControl(ttl: CacheTtl): Anthropic.CacheControlEphemeral {
  if (ttl === '1h' && ONE_HOUR_ENABLED) {
    return { type: 'ephemeral', ttl: '1h' } as unknown as Anthropic.CacheControlEphemeral
  }
  return { type: 'ephemeral' }
}

function textBlock(text: string, ttl?: CacheTtl): Anthropic.TextBlockParam {
  return ttl ? { type: 'text', text, cache_control: cacheControl(ttl) } : { type: 'text', text }
}

// system = [stable preamble @1h] (+ per-coach voice, uncached).
// `voiceContext` keeps the exact "\n\n" separator the single-string form used, so
// the concatenated prompt the model sees is unchanged.
export function buildSystem(preamble: string, voiceContext?: string): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [
    textBlock(preamble, isCacheable(preamble) ? '1h' : undefined),
  ]
  if (voiceContext && voiceContext.trim().length > 0) blocks.push(textBlock(`\n\n${voiceContext}`))
  return blocks
}

// user = [reused per-coach context @5m] + [per-call tail, uncached].
// Callers that have no separable per-coach context pass only `tail`.
export function buildUserContent(coachContext: string, tail: string): Anthropic.TextBlockParam[] {
  if (!coachContext) return [textBlock(tail)]
  // Don't spend a breakpoint on a block too small to cache — the API would ignore
  // it and the prefix it defines has no value on its own.
  return [textBlock(coachContext, isCacheable(coachContext) ? '5m' : undefined), textBlock(tail)]
}

export type CacheUsage = { creation: number; read: number }

export function readCacheUsage(usage: Anthropic.Usage | undefined): CacheUsage {
  return {
    creation: usage?.cache_creation_input_tokens ?? 0,
    read: usage?.cache_read_input_tokens ?? 0,
  }
}
