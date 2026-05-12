/**
 * Cache-aware cost computation for sentinel LLM calls.
 *
 * Centralises the cost formula so all four sentinel call sites (text + structured,
 * conversational + non-conversational) compute the same dollar number from the same
 * usage + pricing inputs.
 *
 * Provider-aware semantics:
 * - Anthropic: `usage.inputTokens` already excludes the cached portion (per
 *   AI SDK v5 + @ai-sdk/anthropic). Do NOT subtract `cachedInputTokens`.
 * - OpenAI: `usage.inputTokens` includes cached tokens (AI SDK maps
 *   `prompt_tokens` directly). Subtract `cachedInputTokens` before charging
 *   full input rate, then bill cached tokens at `cacheRead`.
 * - `cacheCreationInputTokens` are billed at `cacheWrite` rate when reported
 *   by a provider. OpenAI prompt caching has no explicit write surcharge.
 * - When `cacheRead` / `cacheWrite` pricing is missing for a model, falls back
 *   to the `input` rate. Net direction depends on the read/write mix:
 *   • cache_read fallback OVERCHARGES (real cache_read ~0.1× input → fallback
 *     to input rate is ~10× too high). For typical workloads dominated by
 *     cache reads, this means the reported cost UNDERSELLS the savings.
 *   • cache_write fallback UNDERCHARGES (real cache_write ~1.25× input →
 *     fallback to input rate is ~20% too low). Marginal effect compared to
 *     cache_read in steady-state operation.
 *   `warnOnceCacheFallback` logs (model, sentinel) once when this kicks in so
 *   the silent skew isn't completely invisible.
 */

import type { CacheAwareUsage, ModelCost } from "../types/llm-call-types.js";
import type { Logger } from "../utils.js";

/**
 * Compute the dollar cost of a single LLM call given cache-aware usage and pricing.
 *
 * Returns 0 when `modelCost` is undefined (e.g. unknown model id or pricing unavailable).
 * All pricing is per-million tokens.
 */
export function computeCost(usage: CacheAwareUsage, modelCost: ModelCost | undefined): number {
  if (!modelCost) return 0;

  const cachedReadTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteTokens = usage.cacheCreationInputTokens ?? 0;
  const fullRateInputTokens =
    modelCost.providerId === "openai" && cachedReadTokens > 0
      ? Math.max(0, usage.inputTokens - cachedReadTokens)
      : usage.inputTokens;

  // Fall back to input rate if the model lacks explicit cache pricing.
  // computeCost itself stays silent; callers handle the warning so it isn't logged
  // every call (would spam thousands of times per conversation).
  const cacheReadRate = modelCost.cacheRead ?? modelCost.input;
  const cacheWriteRate = modelCost.cacheWrite ?? modelCost.input;

  return (
    (fullRateInputTokens / 1_000_000) * modelCost.input +
    (cachedReadTokens / 1_000_000) * cacheReadRate +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate +
    (usage.outputTokens / 1_000_000) * modelCost.output
  );
}

/**
 * Tracks (modelId, sentinelId) pairs we've already warned about for missing
 * cache pricing, so we log at most once per pair instead of per call.
 *
 * Module-scoped on purpose — covers all sentinels in the process. The Set
 * grows monotonically over the process lifetime; in practice the cardinality
 * is bounded by (active model count × active sentinel count), which is small
 * (single-digit to tens for any realistic deployment). Not worth a TTL.
 */
const warnedPairs = new Set<string>();

/**
 * Warn once per (modelId, sentinelId) pair when cache pricing is missing but
 * cached tokens are reported (so cost falls back to input rate).
 */
export function warnOnceCacheFallback(
  logger: Logger | undefined,
  sentinelId: string,
  modelId: string,
  modelCost: ModelCost | undefined,
  usage: CacheAwareUsage,
): void {
  if (!logger || !modelCost) return;
  const hasCacheActivity =
    (usage.cachedInputTokens ?? 0) > 0 || (usage.cacheCreationInputTokens ?? 0) > 0;
  if (!hasCacheActivity) return;
  const missingRead = modelCost.cacheRead === undefined && (usage.cachedInputTokens ?? 0) > 0;
  const missingWrite =
    modelCost.cacheWrite === undefined && (usage.cacheCreationInputTokens ?? 0) > 0;
  if (!missingRead && !missingWrite) return;
  const key = `${sentinelId}::${modelId}`;
  if (warnedPairs.has(key)) return;
  warnedPairs.add(key);
  logger.log(
    `[Sentinel:${sentinelId}] Model ${modelId} reports cache tokens but lacks ${[
      missingRead ? "cacheRead" : null,
      missingWrite ? "cacheWrite" : null,
    ]
      .filter(Boolean)
      .join(
        " + ",
      )} pricing — falling back to input rate for those cache tokens. Reported cost may be skewed.`,
    "info",
  );
}

/**
 * Reset the warn-once registry. Test-only.
 */
export function __resetCacheWarningsForTests(): void {
  warnedPairs.clear();
}
