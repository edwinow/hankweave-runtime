import { describe, expect, test } from "bun:test";
import { sentinelConfigSchema } from "../../server/config-validation/sentinel.schema";
import {
  type AnthropicCacheControlOptions,
  applyAnthropicCacheControlBreakpoint,
} from "../../server/sentinels/cache-control";
import {
  type HankweaveModelMessage,
  hankweaveTextPartSchema,
} from "../../server/types/input-ai-types";
import { hankweaveLlmCallParamsSchema } from "../../server/types/llm-call-types";

const cacheOptions: AnthropicCacheControlOptions = {
  breakpoint: "lastMessage",
  providerOptions: {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
  },
};

describe("Schema widening — providerOptions pass-through", () => {
  test("hankweaveLlmCallParamsSchema accepts top-level providerOptions (two-level shape)", () => {
    const parsed = hankweaveLlmCallParamsSchema.parse({
      temperature: 0,
      providerOptions: {
        anthropic: {
          cacheControl: { type: "ephemeral" },
        },
      },
    });
    expect(parsed.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  test("hankweaveLlmCallParamsSchema rejects non-JSON inner values implicitly accepted", () => {
    // Should accept arbitrary JSON shapes
    const parsed = hankweaveLlmCallParamsSchema.parse({
      providerOptions: {
        openai: { reasoningEffort: "high", arbitrary: { nested: { value: 1 } } },
      },
    });
    expect(parsed.providerOptions?.openai?.reasoningEffort).toBe("high");
  });

  test("hankweaveTextPartSchema accepts text-part providerOptions", () => {
    const parsed = hankweaveTextPartSchema.parse({
      type: "text",
      text: "hello",
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    });
    expect(parsed.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  test("hankweaveTextPartSchema still accepts text-part without providerOptions", () => {
    const parsed = hankweaveTextPartSchema.parse({ type: "text", text: "hello" });
    expect(parsed.text).toBe("hello");
    expect(parsed.providerOptions).toBeUndefined();
  });
});

describe("sentinel.schema — conversational.cache block", () => {
  const baseSentinel = {
    id: "test-sentinel",
    name: "test",
    trigger: { type: "event" as const, on: ["*"] },
    execution: { strategy: "immediate" as const },
    systemPromptText: "system",
    userPromptText: "user",
    model: "anthropic/claude-haiku-4-5",
    conversational: {
      trimmingStrategy: { type: "maxTurns" as const, maxTurns: 10 },
    },
  };

  test("accepts conversational.cache with anthropic cacheControl", () => {
    const parsed = sentinelConfigSchema.parse({
      ...baseSentinel,
      conversational: {
        ...baseSentinel.conversational,
        cache: {
          breakpoint: "lastMessage",
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      },
    });
    expect(parsed.conversational?.cache?.breakpoint).toBe("lastMessage");
    expect(parsed.conversational?.cache?.providerOptions.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  test("conversational.cache is optional (backwards compat)", () => {
    const parsed = sentinelConfigSchema.parse(baseSentinel);
    expect(parsed.conversational?.cache).toBeUndefined();
  });

  test("rejects unknown breakpoint literal", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "anchor",
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
        },
      }),
    ).toThrow();
  });

  // Finding 1 (folded into Commit 2): tighten anthropic.cacheControl shape so a
  // typo'd `type` fails at config-load rather than at the Anthropic API.
  test("rejects typo'd anthropic.cacheControl.type at config-load (Finding 1)", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "lastMessage",
            providerOptions: {
              anthropic: { cacheControl: { type: "epheneral" } },
            },
          },
        },
      }),
    ).toThrow(/ephemeral/);
  });

  test("rejects invalid anthropic.cacheControl.ttl", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "lastMessage",
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral", ttl: "12h" } },
            },
          },
        },
      }),
    ).toThrow(/ttl/);
  });

  test("rejects unknown anthropic.cacheControl keys", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "lastMessage",
            providerOptions: {
              anthropic: {
                cacheControl: { type: "ephemeral", unexpected: true },
              },
            },
          },
        },
      }),
    ).toThrow(/only supports type and ttl/);
  });

  test("rejects empty conversational.cache providerOptions", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "lastMessage",
            providerOptions: {},
          },
        },
      }),
    ).toThrow(/must include at least one provider/);
  });

  test("rejects empty provider entries inside conversational.cache providerOptions", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "lastMessage",
            providerOptions: { anthropic: {} },
          },
        },
      }),
    ).toThrow(/anthropic must include at least one option/);
  });

  test("accepts valid anthropic.cacheControl.ttl values", () => {
    for (const ttl of ["5m", "1h"] as const) {
      const parsed = sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "lastMessage",
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral", ttl } },
            },
          },
        },
      });
      expect(
        (parsed.conversational?.cache?.providerOptions.anthropic as Record<string, unknown>)
          .cacheControl,
      ).toMatchObject({ type: "ephemeral", ttl });
    }
  });

  test("leaves other-provider providerOptions permissive", () => {
    // openai-shaped options should pass even with arbitrary nested keys
    expect(() =>
      sentinelConfigSchema.parse({
        ...baseSentinel,
        conversational: {
          ...baseSentinel.conversational,
          cache: {
            breakpoint: "lastMessage",
            providerOptions: {
              openai: { reasoningEffort: "high", whatever: { nested: true } },
            },
          },
        },
      }),
    ).not.toThrow();
  });
});

describe("sentinel.schema — chunkedWindow trimming strategy", () => {
  const base = {
    id: "cw-sentinel",
    name: "test",
    trigger: { type: "event" as const, on: ["*"] },
    execution: { strategy: "immediate" as const },
    systemPromptText: "system",
    userPromptText: "user",
    model: "anthropic/claude-haiku-4-5",
  };

  test("accepts chunkedWindow with maxTurns + shiftTurns", () => {
    const parsed = sentinelConfigSchema.parse({
      ...base,
      conversational: {
        trimmingStrategy: { type: "chunkedWindow", maxTurns: 70, shiftTurns: 20 },
      },
    });
    expect(parsed.conversational?.trimmingStrategy).toEqual({
      type: "chunkedWindow",
      maxTurns: 70,
      shiftTurns: 20,
    });
  });

  test("rejects when shiftTurns > maxTurns", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...base,
        conversational: {
          trimmingStrategy: { type: "chunkedWindow", maxTurns: 10, shiftTurns: 11 },
        },
      }),
    ).toThrow(/shiftTurns/);
  });

  test("accepts shiftTurns === maxTurns", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...base,
        conversational: {
          trimmingStrategy: { type: "chunkedWindow", maxTurns: 5, shiftTurns: 5 },
        },
      }),
    ).not.toThrow();
  });

  test("rejects non-positive shiftTurns / maxTurns", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...base,
        conversational: {
          trimmingStrategy: { type: "chunkedWindow", maxTurns: 5, shiftTurns: 0 },
        },
      }),
    ).toThrow();
    expect(() =>
      sentinelConfigSchema.parse({
        ...base,
        conversational: {
          trimmingStrategy: { type: "chunkedWindow", maxTurns: 0, shiftTurns: 1 },
        },
      }),
    ).toThrow();
  });

  test("backwards compat: maxTurns and maxTokens still validate", () => {
    expect(() =>
      sentinelConfigSchema.parse({
        ...base,
        conversational: { trimmingStrategy: { type: "maxTurns", maxTurns: 50 } },
      }),
    ).not.toThrow();
    expect(() =>
      sentinelConfigSchema.parse({
        ...base,
        conversational: { trimmingStrategy: { type: "maxTokens", maxTokens: 8000 } },
      }),
    ).not.toThrow();
  });
});

describe("applyAnthropicCacheControlBreakpoint (lastMessage)", () => {
  test("returns empty array for empty input without throwing", () => {
    const result = applyAnthropicCacheControlBreakpoint([], cacheOptions);
    expect(result).toEqual([]);
  });

  test("marks the LAST user/assistant message with cacheControl, converts ALL to parts-form", () => {
    const messages: HankweaveModelMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "first turn" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second turn" },
    ];

    const result = applyAnthropicCacheControlBreakpoint(messages, cacheOptions);

    expect(result).toHaveLength(4);
    // System message passes through unchanged (no cache marker on system path)
    expect(result[0]).toBe(messages[0]);

    // FIRST and middle user/assistant messages converted to parts-form WITHOUT a marker.
    // (Critical for byte-stability: mixing string + parts across fires breaks
    // Anthropic prefix matching.)
    const first = result[1];
    expect(Array.isArray(first.content)).toBe(true);
    const firstParts = first.content as Array<{ type: string; providerOptions?: unknown }>;
    expect(firstParts[0].providerOptions).toBeUndefined();

    const middle = result[2];
    expect(Array.isArray(middle.content)).toBe(true);
    const middleParts = middle.content as Array<{ type: string; providerOptions?: unknown }>;
    expect(middleParts[0].providerOptions).toBeUndefined();

    // LAST user/assistant (index 3) is the marker target — gets cacheControl + parts-form
    const last = result[3];
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    const lastParts = last.content as Array<{
      type: string;
      text?: string;
      providerOptions?: { anthropic?: { cacheControl?: unknown } };
    }>;
    expect(lastParts[0].text).toBe("second turn");
    expect(lastParts[0].providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  test("when only one user/assistant message exists, marks it", () => {
    const messages: HankweaveModelMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    const result = applyAnthropicCacheControlBreakpoint(messages, cacheOptions);

    // Last user/assistant is the assistant at index 1 — gets the marker
    const last = result[1];
    expect(last.role).toBe("assistant");
    const lastParts = last.content as Array<{ type: string; providerOptions?: unknown }>;
    expect(lastParts[0].providerOptions).toBeDefined();

    // The user at index 0 is converted to parts-form but unmarked
    const first = result[0];
    const firstParts = first.content as Array<{ type: string; providerOptions?: unknown }>;
    expect(firstParts[0].providerOptions).toBeUndefined();
  });

  test("does not mutate input array or input messages", () => {
    const original: HankweaveModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));

    applyAnthropicCacheControlBreakpoint(original, cacheOptions);

    expect(original).toEqual(snapshot);
    for (const m of original) {
      expect(typeof m.content).toBe("string");
    }
  });

  test("system messages pass through unchanged (by reference); all user/assistant converted to parts", () => {
    const messages: HankweaveModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];

    const result = applyAnthropicCacheControlBreakpoint(messages, cacheOptions);

    expect(result[0]).toBe(messages[0]);
    expect(result[1]).not.toBe(messages[1]);
    expect(result[2]).not.toBe(messages[2]);
    expect(result[3]).not.toBe(messages[3]);
    expect(Array.isArray(result[1].content)).toBe(true);
    expect(Array.isArray(result[2].content)).toBe(true);
    expect(Array.isArray(result[3].content)).toBe(true);
  });

  test("when last user/assistant content is already parts array, attaches cacheControl to last text part", () => {
    const messages: HankweaveModelMessage[] = [
      { role: "user", content: "intro" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    ];

    const result = applyAnthropicCacheControlBreakpoint(messages, cacheOptions);

    // First message: parts-form, no marker
    const firstParts = result[0].content as Array<{ type: string; providerOptions?: unknown }>;
    expect(firstParts[0].providerOptions).toBeUndefined();

    // Last message: parts-form, marker on the LAST text part
    const lastParts = result[1].content as Array<{
      type: string;
      text?: string;
      providerOptions?: { anthropic?: { cacheControl?: unknown } };
    }>;
    expect(lastParts).toHaveLength(2);
    expect(lastParts[0].providerOptions).toBeUndefined();
    expect(lastParts[1].providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  test("when last text part already has providerOptions, preserves them while adding cacheControl", () => {
    const messages: HankweaveModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "world",
            providerOptions: {
              openai: { promptCacheKey: "existing" },
              anthropic: { otherOption: true },
            },
          },
        ],
      },
    ];

    const result = applyAnthropicCacheControlBreakpoint(messages, cacheOptions);
    const parts = result[0].content as Array<{
      type: string;
      providerOptions?: {
        openai?: { promptCacheKey?: string };
        anthropic?: { otherOption?: boolean; cacheControl?: unknown };
      };
    }>;

    expect(parts[0].providerOptions?.openai?.promptCacheKey).toBe("existing");
    expect(parts[0].providerOptions?.anthropic?.otherOption).toBe(true);
    expect(parts[0].providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  test("returns clone unchanged when array contains only system/tool messages (no marker target)", () => {
    const messages: HankweaveModelMessage[] = [{ role: "system", content: "sys" }];
    const result = applyAnthropicCacheControlBreakpoint(messages, cacheOptions);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(messages[0]);
  });
});
