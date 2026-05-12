import { describe, expect, it } from "bun:test";
import { applyAnthropicCacheControlBreakpoint } from "../../server/sentinels/cache-control";
import type { HankweaveModelMessage } from "../../server/types/input-ai-types";

/**
 * Integration test: verifies the full production path engages Anthropic's
 * prompt cache against the real API.
 *
 *   1. Build a stable history (single ~5000-token anchor message).
 *   2. Run the production helper `applyAnthropicCacheControlBreakpoint` to
 *      transform the history into the parts-form + cacheControl shape.
 *   3. Push a fresh "live user" message after the helper runs.
 *   4. Send to Anthropic and assert the API reports cache write on fire 1
 *      and cache read on fire 2.
 *
 * Because the test goes THROUGH the production helper (instead of inlining
 * its own message construction), a regression in the helper that breaks the
 * cache mechanic would surface here. Earlier versions of this test inlined
 * the message shape; that tested the API contract but not the helper.
 *
 * SKIP-by-default. Requires ANTHROPIC_API_KEY to run; un-skip locally with
 * care (spends real money — ~$0.005 per run at the time of writing).
 *
 * The single ~5000-token anchor clears Haiku 4.5's 4096-token cache floor,
 * so the marked prefix alone is large enough to engage the cache.
 */
describe.skip("sentinel cache integration (live Anthropic API)", () => {
  it("engages ephemeral cache on fire 2 via the production helper", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY required to un-skip this test");
    }

    const { generateText } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = anthropic("claude-haiku-4-5");

    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(625);

    // History identical across fires — single user message that the helper
    // will mark with cacheControl. With one user/asst message the marker
    // unambiguously lands on it (lastMessage policy = walk from end → first
    // user/assistant found).
    const history: HankweaveModelMessage[] = [
      { role: "user", content: `anchor: ${filler}` },
    ];

    const cacheOptions = {
      breakpoint: "lastMessage" as const,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" as const } },
      },
    };

    function build(liveUserText: string) {
      const transformed = applyAnthropicCacheControlBreakpoint(history, cacheOptions);
      return [
        ...transformed,
        { role: "user" as const, content: [{ type: "text" as const, text: liveUserText }] },
      ];
    }

    const r1 = await generateText({
      model,
      system: "Reply with one short line.",
      // biome-ignore lint/suspicious/noExplicitAny: AI SDK message-type juggling for test
      messages: build("first new event") as any,
      temperature: 0,
      maxOutputTokens: 32,
    });
    const pm1 = r1.providerMetadata as
      | { anthropic?: { cacheCreationInputTokens?: number } }
      | undefined;
    const cacheCreated1 = pm1?.anthropic?.cacheCreationInputTokens ?? 0;
    expect(cacheCreated1).toBeGreaterThan(0);

    const r2 = await generateText({
      model,
      system: "Reply with one short line.",
      // biome-ignore lint/suspicious/noExplicitAny: AI SDK message-type juggling for test
      messages: build("second new event") as any,
      temperature: 0,
      maxOutputTokens: 32,
    });
    const cachedRead2 = r2.usage?.cachedInputTokens ?? 0;
    expect(cachedRead2).toBeGreaterThan(0);

    // Also assert the input — confirms the helper didn't mutate `history`
    // (which would have thrown off the byte-stable comparison).
    expect(history).toHaveLength(1);
    expect(typeof history[0].content).toBe("string");
  }, 60_000);
});
