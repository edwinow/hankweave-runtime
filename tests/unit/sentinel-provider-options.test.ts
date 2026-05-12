/**
 * Regression tests for WO-77 Commit 1 review Findings 2 + 5:
 * `providerOptions` configured on a sentinel must survive every spread layer
 * and reach `generateText` / `generateObject` from the `ai` SDK intact.
 *
 * Strategy:
 * - Mock `llmCallFn` / `llmObjectCallFn` and assert each construction site in
 *   sentinel.ts passes `options.providerOptions` into the call.
 * - Assert conversational cache options are routed to the correct layer:
 *   OpenAI prompt-cache options stay request-level; Anthropic cacheControl is
 *   attached to the last historical message before the live user.
 */
import { describe, expect, test } from "bun:test";
import type { SentinelConfig } from "../../server/config-validation/sentinel.schema.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { Sentinel } from "../../server/sentinels/sentinel.js";
import { CodonId } from "../../server/types/branded-types.js";
import type {
  HankweaveGenerateObjectOptions,
  HankweaveGenerateObjectResult,
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
} from "../../server/types/llm-call-types.js";

const testEvent: ServerEvent = {
  id: "ev-1",
  timestamp: "2026-01-01T00:00:00Z",
  type: "assistant.action",
  data: {
    content: "x",
    codonId: "test-codon",
    action: "tool_use",
    toolName: "Read",
    toolInput: {},
  },
};

const PROVIDER_OPTIONS = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};

const OPENAI_CACHE_PROVIDER_OPTIONS = {
  openai: {
    promptCacheKey: "sentinel-po-openai",
    promptCacheRetention: "24h",
  },
};

describe("WO-77 Finding 2/5: providerOptions survives spread (Sentinel level)", () => {
  test("text path, non-conversational — providerOptions reaches llmCallFn", async () => {
    const captured: HankweaveGenerateTextOptions[] = [];
    const fakeLlmCall = async (
      _id: string,
      options: HankweaveGenerateTextOptions,
    ): Promise<HankweaveGenerateTextResult> => {
      captured.push(options);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const config: SentinelConfig = {
      id: "po-text-nonconv",
      name: "T",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "x",
      llmParams: { providerOptions: PROVIDER_OPTIONS },
    };
    const sentinel = new Sentinel(config, CodonId("c1"), fakeLlmCall);
    await sentinel.handleEvent(testEvent);
    await sentinel.completeAllWork();

    expect(captured).toHaveLength(1);
    expect(captured[0].providerOptions).toEqual(PROVIDER_OPTIONS);
  });

  test("text path, conversational — providerOptions reaches llmCallFn", async () => {
    const captured: HankweaveGenerateTextOptions[] = [];
    const fakeLlmCall = async (
      _id: string,
      options: HankweaveGenerateTextOptions,
    ): Promise<HankweaveGenerateTextResult> => {
      captured.push(options);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const config: SentinelConfig = {
      id: "po-text-conv",
      name: "T",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      systemPromptText: "sys",
      userPromptText: "x",
      conversational: { trimmingStrategy: { type: "maxTurns", maxTurns: 5 } },
      llmParams: { providerOptions: PROVIDER_OPTIONS },
    };
    const sentinel = new Sentinel(config, CodonId("c1"), fakeLlmCall);
    await sentinel.handleEvent(testEvent);
    await sentinel.completeAllWork();

    expect(captured).toHaveLength(1);
    expect(captured[0].providerOptions).toEqual(PROVIDER_OPTIONS);
  });

  test("text path, conversational cache block — OpenAI prompt cache options reach llmCallFn", async () => {
    const captured: HankweaveGenerateTextOptions[] = [];
    const fakeLlmCall = async (
      _id: string,
      options: HankweaveGenerateTextOptions,
    ): Promise<HankweaveGenerateTextResult> => {
      captured.push(options);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const config: SentinelConfig = {
      id: "po-openai-cache-conv",
      name: "T",
      model: "openai/gpt-5.4",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      systemPromptText: "sys",
      userPromptText: "x",
      conversational: {
        trimmingStrategy: { type: "chunkedWindow", maxTurns: 70, shiftTurns: 20 },
        cache: {
          breakpoint: "lastMessage",
          providerOptions: OPENAI_CACHE_PROVIDER_OPTIONS,
        },
      },
    };
    const sentinel = new Sentinel(config, CodonId("c1"), fakeLlmCall);
    await sentinel.handleEvent(testEvent);
    await sentinel.completeAllWork();

    expect(captured).toHaveLength(1);
    expect(captured[0].providerOptions).toEqual(OPENAI_CACHE_PROVIDER_OPTIONS);
  });

  test("text path, conversational cache block — Anthropic cacheControl is message-part only", async () => {
    const captured: HankweaveGenerateTextOptions[] = [];
    const fakeLlmCall = async (
      _id: string,
      options: HankweaveGenerateTextOptions,
    ): Promise<HankweaveGenerateTextResult> => {
      captured.push(options);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const config: SentinelConfig = {
      id: "po-anthropic-cache-conv",
      name: "T",
      model: "anthropic/claude-haiku-4-5",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      systemPromptText: "sys",
      userPromptText: "x",
      conversational: {
        trimmingStrategy: { type: "chunkedWindow", maxTurns: 70, shiftTurns: 20 },
        cache: {
          breakpoint: "lastMessage",
          providerOptions: PROVIDER_OPTIONS,
        },
      },
    };
    const sentinel = new Sentinel(config, CodonId("c1"), fakeLlmCall);
    await sentinel.handleEvent(testEvent);
    await sentinel.handleEvent(testEvent);
    await sentinel.completeAllWork();

    expect(captured).toHaveLength(2);
    expect(captured[1].providerOptions).toBeUndefined();
    const secondCallMessages = captured[1].messages;
    expect(secondCallMessages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);

    const historicalUserMessage = secondCallMessages[1];
    const markedMessageIndexes = secondCallMessages.flatMap((message, index) => {
      const isMarked = Array.isArray(message.content)
        ? message.content.some((part) => {
            const providerOptions =
              "providerOptions" in part
                ? (part.providerOptions as
                    | { anthropic?: { cacheControl?: { type?: unknown } } }
                    | undefined)
                : undefined;
            return providerOptions?.anthropic?.cacheControl?.type === "ephemeral";
          })
        : false;
      return isMarked ? [index] : [];
    });
    expect(markedMessageIndexes).toEqual([2]);

    const markedMessage = secondCallMessages[2];
    expect(Array.isArray(historicalUserMessage.content)).toBe(true);
    expect(Array.isArray(markedMessage.content)).toBe(true);
    const liveUserMessage = secondCallMessages[3];
    expect(liveUserMessage.role).toBe("user");
    expect(
      Array.isArray(liveUserMessage.content) &&
        liveUserMessage.content.some((part) => {
          const providerOptions =
            "providerOptions" in part
              ? (part.providerOptions as
                  | { anthropic?: { cacheControl?: { type?: unknown } } }
                  | undefined)
              : undefined;
          return providerOptions?.anthropic?.cacheControl?.type === "ephemeral";
        }),
    ).toBe(false);
  });

  test("structured path, non-conversational (Finding 5, line 847) — providerOptions reaches llmObjectCall", async () => {
    const captured: HankweaveGenerateObjectOptions[] = [];
    const fakeLlmCall = async (): Promise<HankweaveGenerateTextResult> => ({
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const fakeLlmObjectCall = async (
      _id: string,
      opts: HankweaveGenerateObjectOptions,
    ): Promise<HankweaveGenerateObjectResult<unknown>> => {
      captured.push(opts);
      return {
        object: { ok: true },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const config: SentinelConfig = {
      id: "po-struct-nonconv",
      name: "T",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "x",
      structuredOutput: {
        output: "object",
        schemaStr: "z.object({ ok: z.boolean() })",
      },
      llmParams: { providerOptions: PROVIDER_OPTIONS },
    };
    // Bypass file-based schema loading by injecting structuredOutputContext via
    // schemaStr — Sentinel's loader compiles the inline schema string.
    const sentinel = new Sentinel(
      config,
      CodonId("c1"),
      fakeLlmCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeLlmObjectCall,
    );
    await sentinel.handleEvent(testEvent);
    await sentinel.completeAllWork();

    expect(captured).toHaveLength(1);
    expect(captured[0].providerOptions).toEqual(PROVIDER_OPTIONS);
  });

  test("cache fields appear in sentinel.output event payload + cost uses cache pricing", async () => {
    type SentinelEvent = import("../../server/schemas/event-schemas.js").SentinelEvent;
    const captured: SentinelEvent[] = [];
    const fakeLlmCall = async (): Promise<HankweaveGenerateTextResult> => ({
      text: "ok",
      finishReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 1000,
        cacheCreationInputTokens: 200,
      },
    });

    const config: SentinelConfig = {
      id: "po-cache-event",
      name: "T",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "x",
    };
    // Pricing: input=1, output=5, cacheRead=0.1, cacheWrite=1.25 per million.
    const sentinel = new Sentinel(
      config,
      CodonId("c1"),
      fakeLlmCall,
      undefined, // logger
      undefined, // sentinelDir
      undefined, // configDirectory
      undefined, // runStartTime
      undefined, // onExecute
      { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, // modelCost
      undefined, // llmObjectCall
      undefined, // executionPath
      undefined, // agentRootPath
      undefined, // outputPaths
      (event: SentinelEvent) => captured.push(event), // sendEventToServer
    );
    await sentinel.handleEvent(testEvent);
    await sentinel.completeAllWork();

    const outputEvent = captured.find((e) => e.type === "sentinel.output");
    expect(outputEvent).toBeDefined();
    if (outputEvent && outputEvent.type === "sentinel.output") {
      expect(outputEvent.data.tokens.input).toBe(100);
      expect(outputEvent.data.tokens.output).toBe(50);
      expect(outputEvent.data.tokens.cachedInputTokens).toBe(1000);
      expect(outputEvent.data.tokens.cacheCreationInputTokens).toBe(200);
      // Cost: 100*1/M + 1000*0.1/M + 200*1.25/M + 50*5/M
      const expected = 100e-6 + 100e-6 + 250e-6 + 250e-6;
      expect(outputEvent.data.cost).toBeCloseTo(expected, 12);
    }
  });

  test("structured path, conversational — providerOptions reaches llmObjectCall", async () => {
    const captured: HankweaveGenerateObjectOptions[] = [];
    const fakeLlmCall = async (): Promise<HankweaveGenerateTextResult> => ({
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const fakeLlmObjectCall = async (
      _id: string,
      opts: HankweaveGenerateObjectOptions,
    ): Promise<HankweaveGenerateObjectResult<unknown>> => {
      captured.push(opts);
      return {
        object: { ok: true },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const config: SentinelConfig = {
      id: "po-struct-conv",
      name: "T",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      systemPromptText: "sys",
      userPromptText: "x",
      conversational: { trimmingStrategy: { type: "maxTurns", maxTurns: 5 } },
      structuredOutput: {
        output: "object",
        schemaStr: "z.object({ ok: z.boolean() })",
      },
      llmParams: { providerOptions: PROVIDER_OPTIONS },
    };
    const sentinel = new Sentinel(
      config,
      CodonId("c1"),
      fakeLlmCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeLlmObjectCall,
    );
    await sentinel.handleEvent(testEvent);
    await sentinel.completeAllWork();

    expect(captured).toHaveLength(1);
    expect(captured[0].providerOptions).toEqual(PROVIDER_OPTIONS);
  });
});
