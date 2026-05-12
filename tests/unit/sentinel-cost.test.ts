import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetCacheWarningsForTests,
  computeCost,
  warnOnceCacheFallback,
} from "../../server/sentinels/cost.js";
import type { CacheAwareUsage, ModelCost } from "../../server/types/llm-call-types.js";
import { Logger } from "../../server/utils.js";

class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];
  constructor() {
    super("/dev/null");
  }
  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }
}

// Pricing roughly modelled on claude-haiku-4-5 (per million):
// input=1, output=5, cacheRead=0.1, cacheWrite=1.25
const haikuCost: ModelCost = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25,
};

describe("computeCost", () => {
  beforeEach(() => __resetCacheWarningsForTests());

  test("returns 0 when modelCost is undefined", () => {
    expect(computeCost({ inputTokens: 100, outputTokens: 50 }, undefined)).toBe(0);
  });

  test("plain input/output (no cache fields)", () => {
    const usage: CacheAwareUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
    // 1.0 + 2.5 = 3.5
    expect(computeCost(usage, haikuCost)).toBeCloseTo(3.5, 10);
  });

  test("uses cacheRead/cacheWrite when present", () => {
    const usage: CacheAwareUsage = {
      inputTokens: 100, // already excludes cached portion
      outputTokens: 200,
      cachedInputTokens: 1000,
      cacheCreationInputTokens: 200,
    };
    const expected =
      (100 / 1_000_000) * 1 +
      (1000 / 1_000_000) * 0.1 +
      (200 / 1_000_000) * 1.25 +
      (200 / 1_000_000) * 5;
    expect(computeCost(usage, haikuCost)).toBeCloseTo(expected, 12);
  });

  test("does NOT subtract cached tokens from input (already excluded by AI SDK)", () => {
    // If we mistakenly subtracted cached from input, this would underbill.
    // Verify the formula treats inputTokens as final.
    const usageWithCache: CacheAwareUsage = {
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 1000,
    };
    const usageWithoutCache: CacheAwareUsage = {
      inputTokens: 100,
      outputTokens: 0,
    };
    const withCache = computeCost(usageWithCache, haikuCost);
    const withoutCache = computeCost(usageWithoutCache, haikuCost);
    // Difference should be exactly the cacheRead cost (1000 tokens at 0.1/M).
    expect(withCache - withoutCache).toBeCloseTo((1000 / 1_000_000) * 0.1, 12);
  });

  test("falls back to input rate when cacheRead is missing", () => {
    const noCacheReadCost: ModelCost = { input: 1, output: 5, cacheWrite: 1.25 };
    const usage: CacheAwareUsage = {
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 1000,
    };
    // Cached portion bills at input rate (1/M) instead of cacheRead.
    const expected = (100 / 1_000_000) * 1 + (1000 / 1_000_000) * 1;
    expect(computeCost(usage, noCacheReadCost)).toBeCloseTo(expected, 12);
  });

  test("falls back to input rate when cacheWrite is missing", () => {
    const noCacheWriteCost: ModelCost = { input: 1, output: 5, cacheRead: 0.1 };
    const usage: CacheAwareUsage = {
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationInputTokens: 200,
    };
    const expected = (100 / 1_000_000) * 1 + (200 / 1_000_000) * 1;
    expect(computeCost(usage, noCacheWriteCost)).toBeCloseTo(expected, 12);
  });

  test("uses OpenAI inclusive cache semantics", () => {
    const openAiCost: ModelCost = {
      providerId: "openai",
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
    };
    const usage: CacheAwareUsage = {
      inputTokens: 3000, // OpenAI prompt_tokens includes the cached subset.
      outputTokens: 500,
      cachedInputTokens: 2000,
    };
    const expected = (1000 / 1_000_000) * 2.5 + (2000 / 1_000_000) * 0.25 + (500 / 1_000_000) * 15;
    expect(computeCost(usage, openAiCost)).toBeCloseTo(expected, 12);
  });

  test("clamps OpenAI fresh input tokens when cached tokens exceed input tokens", () => {
    const openAiCost: ModelCost = {
      providerId: "openai",
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
    };
    const usage: CacheAwareUsage = {
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 1200,
    };
    expect(computeCost(usage, openAiCost)).toBeCloseTo((1200 / 1_000_000) * 0.25, 12);
  });
});

describe("warnOnceCacheFallback", () => {
  beforeEach(() => __resetCacheWarningsForTests());

  test("warns once per (sentinelId, modelId) pair when cache pricing missing", () => {
    const logger = new MockLogger();
    const partialCost: ModelCost = { input: 1, output: 5 };
    const usage: CacheAwareUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 100 };

    warnOnceCacheFallback(logger, "sent-1", "anthropic/claude-haiku-4-5", partialCost, usage);
    warnOnceCacheFallback(logger, "sent-1", "anthropic/claude-haiku-4-5", partialCost, usage);
    warnOnceCacheFallback(logger, "sent-1", "anthropic/claude-haiku-4-5", partialCost, usage);

    const warnings = logger.logs.filter((l) => l.message.includes("falling back to input rate"));
    expect(warnings.length).toBe(1);
  });

  test("warns separately per sentinel", () => {
    const logger = new MockLogger();
    const partialCost: ModelCost = { input: 1, output: 5 };
    const usage: CacheAwareUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 100 };
    warnOnceCacheFallback(logger, "sent-A", "model-x", partialCost, usage);
    warnOnceCacheFallback(logger, "sent-B", "model-x", partialCost, usage);
    const warnings = logger.logs.filter((l) => l.message.includes("falling back"));
    expect(warnings.length).toBe(2);
  });

  test("does not warn when cache pricing is fully present", () => {
    const logger = new MockLogger();
    const usage: CacheAwareUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 50,
    };
    warnOnceCacheFallback(logger, "sent-1", "model-x", haikuCost, usage);
    expect(logger.logs.length).toBe(0);
  });

  test("does not warn when no cache activity reported", () => {
    const logger = new MockLogger();
    const partialCost: ModelCost = { input: 1, output: 5 };
    const usage: CacheAwareUsage = { inputTokens: 100, outputTokens: 50 };
    warnOnceCacheFallback(logger, "sent-1", "model-x", partialCost, usage);
    expect(logger.logs.length).toBe(0);
  });
});
