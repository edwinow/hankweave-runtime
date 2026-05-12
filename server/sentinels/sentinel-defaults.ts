import type { HankweaveLlmCallParams } from "../types/llm-call-types.js";

/**
 * Default LLM parameters for sentinels.
 * These provide sensible defaults that can be overridden per-sentinel.
 *
 * Note: typed as `Required<Pick<...>>` over the always-defaulted scalar fields
 * only. Optional pass-through fields like `providerOptions` are intentionally
 * not required in the defaults literal — they merge in from sentinel config.
 */
export const DEFAULT_SENTINEL_LLM_PARAMS: Required<
  Pick<HankweaveLlmCallParams, "temperature" | "maxOutputTokens" | "maxRetries">
> = {
  temperature: 0, // Deterministic by default for consistent sentinel output
  maxOutputTokens: 8192, // Reasonable default for most sentinel responses
  maxRetries: 2, // Retry failed calls twice before giving up
} as const;

/**
 * Merges sentinel-specific LLM params with defaults.
 * Sentinel params take precedence over defaults.
 */
export function mergeWithDefaults(sentinelParams?: HankweaveLlmCallParams): HankweaveLlmCallParams {
  return {
    ...DEFAULT_SENTINEL_LLM_PARAMS,
    ...(sentinelParams ?? {}),
  };
}
