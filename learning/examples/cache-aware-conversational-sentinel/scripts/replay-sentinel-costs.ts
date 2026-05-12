#!/usr/bin/env bun
/**
 * Replay sentinel cost estimator for the cache-aware-conversational-sentinel demo.
 *
 * DEFAULT MODE — deterministic dry-run estimator (no API calls, no money spent):
 *
 *   bun scripts/replay-sentinel-costs.ts \
 *     --strategy chunkedWindow \
 *     --cache on \
 *     [--fires 100] \
 *     [--tokens-per-turn 285] \
 *     [--system-tokens 250] \
 *     [--reply-tokens 8] \
 *     [--events <path-to-events.jsonl>] \
 *     [--out ./results/<provider>-<strategy>-cache-<on|off>.jsonl]
 *
 * If --events is supplied, the estimator counts `tool.result` events in the JSONL
 * file to determine the fire count and uses --tokens-per-turn as the per-event
 * size. Otherwise it falls back to --fires.
 *
 * REAL MODE — actually call Anthropic and record the model's reported usage:
 *
 *   ANTHROPIC_API_KEY=... bun scripts/replay-sentinel-costs.ts \
 *     --strategy chunkedWindow --cache on --real-api
 *
 * Loud-fails if ANTHROPIC_API_KEY is missing. Real mode is opt-in only.
 *
 * OUTPUT: writes one JSONL line per fire to results/<basename>.jsonl, plus a
 * trailing summary line `{ "summary": true, ... }`. compare-results.ts reads
 * those summary lines.
 *
 * COST MODEL (haiku-4-5 from server/llm/models-dev-data.json:74905):
 *   input        = $1.00 / Mtok
 *   output       = $5.00 / Mtok
 *   cache_read   = $0.10 / Mtok
 *   cache_write  = $1.25 / Mtok
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Strategy = "maxTurns" | "chunkedWindow";
type CacheMode = "on" | "off";

interface Args {
  strategy: Strategy;
  cache: CacheMode;
  fires: number;
  tokensPerTurn: number;
  systemTokens: number;
  replyTokens: number;
  eventsPath: string | null;
  outPath: string | null;
  realApi: boolean;
  maxTurns: number;
  shiftTurns: number;
  provider: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    strategy: "chunkedWindow",
    cache: "on",
    fires: 100,
    tokensPerTurn: 285,
    systemTokens: 250,
    replyTokens: 8,
    eventsPath: null,
    outPath: null,
    realApi: false,
    maxTurns: 70,
    shiftTurns: 20,
    provider: "anthropic",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const take = () => {
      if (!next) throw new Error(`${a} requires a value`);
      i++;
      return next;
    };
    switch (a) {
      case "--strategy": {
        const v = take();
        if (v !== "maxTurns" && v !== "chunkedWindow") {
          throw new Error(`--strategy must be maxTurns or chunkedWindow, got ${v}`);
        }
        args.strategy = v;
        break;
      }
      case "--cache": {
        const v = take();
        if (v !== "on" && v !== "off") throw new Error(`--cache must be on or off, got ${v}`);
        args.cache = v;
        break;
      }
      case "--fires":
        args.fires = parseInt(take(), 10);
        break;
      case "--tokens-per-turn":
        args.tokensPerTurn = parseInt(take(), 10);
        break;
      case "--system-tokens":
        args.systemTokens = parseInt(take(), 10);
        break;
      case "--reply-tokens":
        args.replyTokens = parseInt(take(), 10);
        break;
      case "--events":
        args.eventsPath = take();
        break;
      case "--out":
        args.outPath = take();
        break;
      case "--real-api":
        args.realApi = true;
        break;
      case "--max-turns":
        args.maxTurns = parseInt(take(), 10);
        break;
      case "--shift-turns":
        args.shiftTurns = parseInt(take(), 10);
        break;
      case "--provider":
        args.provider = take();
        break;
      case "-h":
      case "--help":
        console.log(__doc__());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown arg ${a}`);
    }
  }
  // Provider validation — only Anthropic is supported by this script's pricing
  // and cache semantics. Anything else would silently bill at Anthropic rates
  // while labelling the output file with the wrong provider.
  if (args.provider !== "anthropic") {
    throw new Error(
      `Unsupported provider "${args.provider}". This estimator currently models Anthropic Claude pricing only.`,
    );
  }
  return args;
}

function __doc__(): string {
  return `Replay sentinel costs. See file header for full usage.`;
}

// Pricing per 1M tokens, snapshotted from models-dev-data.json (claude-haiku-4-5).
const PRICING = {
  input: 1.0,
  output: 5.0,
  cacheRead: 0.1,
  cacheWrite: 1.25,
};

function computeCost(usage: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}): number {
  return (
    (usage.inputTokens / 1_000_000) * PRICING.input +
    (usage.cachedInputTokens / 1_000_000) * PRICING.cacheRead +
    (usage.cacheCreationInputTokens / 1_000_000) * PRICING.cacheWrite +
    (usage.outputTokens / 1_000_000) * PRICING.output
  );
}

/**
 * Pre-LLM stored complete turns just before fire N.
 * Mirrors history-manager.ts prune() semantics for both strategies.
 */
function preFireStoredTurns(
  fireN: number,
  strategy: Strategy,
  maxTurns: number,
  shiftTurns: number,
): number {
  // Walk the trim machine. fireN is 1-indexed.
  let stored = 0;
  for (let n = 1; n <= fireN; n++) {
    if (n === fireN) return stored;
    // After fire n: stored grows by 1 (the new turn we just produced), then prune.
    stored += 1;
    if (strategy === "maxTurns") {
      // prune drops 1 turn whenever stored > maxTurns (strict greater).
      if (stored > maxTurns) stored = maxTurns;
    } else {
      // chunkedWindow: when stored > maxTurns, splice(0, shiftTurns * 2) → drop shiftTurns turns.
      if (stored > maxTurns) stored -= shiftTurns;
    }
  }
  return stored;
}

/**
 * Did a shift event happen between (fireN - 1) and fireN, where the prior fire's
 * post-prune state had a window incompatible with the current?
 *
 * For maxTurns: a "shift" effectively happens every fire once at cap, since one turn
 * is dropped. For chunkedWindow: shift only at the trigger fires.
 */
function isPrefixUnstableSinceLastFire(
  fireN: number,
  strategy: Strategy,
  maxTurns: number,
  shiftTurns: number,
): boolean {
  if (fireN <= 1) return true;
  const prevPost = preFireStoredTurns(fireN, strategy, maxTurns, shiftTurns);
  const prevPostPrev = preFireStoredTurns(fireN - 1, strategy, maxTurns, shiftTurns) + 1;
  // If prevPost === prevPostPrev (i.e. no prune happened to the prior fire), prefix grew by 1.
  // If prevPost < prevPostPrev, a prune happened — prefix shifted.
  return prevPost < prevPostPrev;
}

interface FireResult {
  fire: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/**
 * Dry-run simulator. For each fire, compute:
 *   - stored turns before LLM call
 *   - input tokens (system + history + current user event)
 *   - output tokens (constant reply)
 *   - cache reads / writes per the cache+strategy interaction
 */
function simulate(args: Args): FireResult[] {
  const results: FireResult[] = [];
  const tpt = args.tokensPerTurn; // tokens per stored turn (avg user+assistant pair)
  const sys = args.systemTokens;
  const reply = args.replyTokens;

  // Track what prefix is currently cached server-side (token count).
  // We assume at most one breakpoint at a time and that an unbroken growth of the prefix
  // since the last write produces a clean read-of-old + write-of-new pattern.
  let cachedPrefixTokens = 0;

  for (let n = 1; n <= args.fires; n++) {
    const storedTurns = preFireStoredTurns(n, args.strategy, args.maxTurns, args.shiftTurns);
    const historyTokens = storedTurns * tpt;
    // The current user message carries the event payload (~tpt tokens-per-event).
    const currentUserTokens = tpt;
    const totalPromptTokens = sys + historyTokens + currentUserTokens;

    let inputTokens = totalPromptTokens;
    let cachedInputTokens = 0;
    let cacheCreationInputTokens = 0;

    if (args.cache === "on") {
      const shifted = isPrefixUnstableSinceLastFire(
        n,
        args.strategy,
        args.maxTurns,
        args.shiftTurns,
      );
      if (shifted) {
        // Cache invalidated: previous cached prefix no longer matches.
        // Write a fresh breakpoint at the new last historical message (= sys + historyTokens).
        cachedPrefixTokens = 0;
      }
      // Breakpoint goes on the last historical message. With zero history there
      // is no message to attach it to, so no caching happens this fire.
      const targetCacheTokens = historyTokens > 0 ? sys + historyTokens : 0;
      if (targetCacheTokens <= 0) {
        // Fire with no history: nothing to cache. Skip.
      } else if (cachedPrefixTokens === 0) {
        // First write since last invalidation.
        cacheCreationInputTokens = targetCacheTokens;
        inputTokens = currentUserTokens; // the only fresh tokens
        cachedPrefixTokens = targetCacheTokens;
      } else if (targetCacheTokens > cachedPrefixTokens) {
        // Incremental: read the prior cached prefix, write the delta.
        const delta = targetCacheTokens - cachedPrefixTokens;
        cachedInputTokens = cachedPrefixTokens;
        cacheCreationInputTokens = delta;
        inputTokens = currentUserTokens;
        cachedPrefixTokens = targetCacheTokens;
      } else {
        // Same prefix as before (no growth) — pure read.
        cachedInputTokens = cachedPrefixTokens;
        inputTokens = currentUserTokens;
      }
    }

    // Anthropic semantics: usage.inputTokens already excludes the cached portion.
    const usage = {
      inputTokens,
      outputTokens: reply,
      cachedInputTokens,
      cacheCreationInputTokens,
    };
    results.push({
      fire: n,
      ...usage,
      costUsd: computeCost(usage),
    });
  }

  return results;
}

/** Count tool.result events in an events.jsonl file (best-effort). */
function countToolResultEvents(path: string): number {
  const data = readFileSync(path, "utf8");
  let count = 0;
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { type?: string };
      if (obj.type === "tool.result") count++;
    } catch {
      // skip malformed
    }
  }
  return count;
}

async function realApiRun(args: Args): Promise<FireResult[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for --real-api. Re-run with the env var set, or omit --real-api to use the dry-run estimator.",
    );
  }
  // Use the AI SDK exactly the way the sentinel does so we exercise the same path.
  const { generateText } = await import("ai");
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = anthropic("claude-haiku-4-5");

  const results: FireResult[] = [];
  const history: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: "text"; text: string; providerOptions?: unknown }>;
  }> = [];

  // Filler text — natural English so the tokeniser produces a realistic
  // token-per-character ratio (~5 chars/tok). Repeated single-char strings
  // (e.g. "xxxx...") compress dramatically and produce way fewer tokens than
  // expected, defeating the test.
  const FILLER_BASE = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  const filler = FILLER_BASE.repeat(Math.ceil(args.tokensPerTurn / 8));

  for (let n = 1; n <= args.fires; n++) {
    const evt = `tool.result fire ${n}: ${filler}`;
    // Apply trim per strategy
    const storedTarget = preFireStoredTurns(n, args.strategy, args.maxTurns, args.shiftTurns);
    while (history.length > storedTarget * 2) history.shift();

    // Apply lastMessage cacheControl strategy if --cache on:
    // mark the LAST historical message + convert ALL history to parts-form.
    // Both are required for Anthropic prefix caching to engage cache READS
    // across fires:
    //   1. all-parts-form ensures byte-stable JSON shape across fires
    //   2. marker on the last historical message lets Anthropic's auto-prefix-
    //      checking (~20 blocks back from the marker) find and extend the
    //      previously-cached prefix.
    // Empirically validated: lastMessage is 2.4× cheaper than anchored-on-first
    // at production scale (M=70, S=20, 100 fires) — see ops findings ledger.
    let sentMessages: Array<{
      role: "user" | "assistant";
      content: string | Array<{ type: "text"; text: string; providerOptions?: unknown }>;
    }>;
    if (args.cache === "on" && history.length > 0) {
      const markerIndex = history.length - 1;
      sentMessages = history.map((m, i) => {
        const text = typeof m.content === "string" ? m.content : "";
        return {
          role: m.role,
          content: [
            {
              type: "text",
              text,
              ...(i === markerIndex
                ? {
                    providerOptions: {
                      anthropic: { cacheControl: { type: "ephemeral" } },
                    },
                  }
                : {}),
            },
          ],
        };
      });
    } else {
      sentMessages = history.map((m) => ({ ...m }));
    }
    sentMessages.push({ role: "user", content: evt });

    const response = await generateText({
      model,
      system:
        "You are a silent observer for a cache-cost demonstration. Reply with one short line.",
      // biome-ignore lint/suspicious/noExplicitAny: ai-sdk type juggling for demo
      messages: sentMessages as any,
      temperature: 0,
      maxOutputTokens: 32,
    });

    const providerMetadata = response.providerMetadata as
      | { anthropic?: { cacheCreationInputTokens?: number } }
      | undefined;
    const usage = {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      cachedInputTokens: response.usage?.cachedInputTokens ?? 0,
      cacheCreationInputTokens: providerMetadata?.anthropic?.cacheCreationInputTokens ?? 0,
    };
    results.push({ fire: n, ...usage, costUsd: computeCost(usage) });

    // Append the just-completed turn to history for next fire.
    history.push({ role: "user", content: evt });
    history.push({ role: "assistant", content: response.text });
  }
  return results;
}

function totals(results: FireResult[]) {
  return results.reduce(
    (acc, r) => {
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.cachedInputTokens += r.cachedInputTokens;
      acc.cacheCreationInputTokens += r.cacheCreationInputTokens;
      acc.costUsd += r.costUsd;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    },
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve fire count from --events if provided
  if (args.eventsPath) {
    const detected = countToolResultEvents(args.eventsPath);
    if (detected > 0) {
      args.fires = detected;
      console.error(`[replay] detected ${detected} tool.result events in ${args.eventsPath}`);
    } else {
      console.error(
        `[replay] WARN: 0 tool.result events found in ${args.eventsPath}; falling back to --fires=${args.fires}`,
      );
    }
  }

  const results = args.realApi ? await realApiRun(args) : simulate(args);
  const sum = totals(results);

  const outPath =
    args.outPath ??
    `./results/${args.provider}-${args.strategy}-cache-${args.cache}${args.realApi ? "-realapi" : ""}.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = results.map((r) => JSON.stringify(r));
  lines.push(
    JSON.stringify({
      summary: true,
      strategy: args.strategy,
      cache: args.cache,
      provider: args.provider,
      fires: results.length,
      realApi: args.realApi,
      ...sum,
    }),
  );
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

  console.log(`Wrote ${results.length} fires + summary to ${outPath}`);
  console.log(
    `  total input=${sum.inputTokens}  cachedRead=${sum.cachedInputTokens}  cacheWrite=${sum.cacheCreationInputTokens}  output=${sum.outputTokens}  cost=$${sum.costUsd.toFixed(6)}`,
  );
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
