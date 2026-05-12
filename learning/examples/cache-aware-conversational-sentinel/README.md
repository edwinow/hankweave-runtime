# Cache-aware Conversational Sentinel

**A worked example showing how `chunkedWindow` trimming + Anthropic ephemeral `cacheControl` can materially reduce conversational-sentinel cost on long-history workloads.**

## What this example demonstrates

Two observer sentinels watch the same codon. They differ only in their conversational config. Replaying the same fire stream through each gives a clean 4-cell comparison:

```
                    cache OFF                      cache ON
                ┌─────────────────────┐    ┌─────────────────────┐
   maxTurns:70  │  baseline (today)   │    │ frequent prefix      │
                │  pays full prefix   │    │ every fire past 71   │
                │  every fire         │    │ shifts lose savings  │
                └─────────────────────┘    └─────────────────────┘
                ┌─────────────────────┐    ┌─────────────────────┐
   chunked      │  same as baseline   │    │ best case:           │
   {70, 20}     │  (no cache)         │    │ stable prefix between│
                │                     │    │ shifts → big savings │
                └─────────────────────┘    └─────────────────────┘
```

The bottom-right cell is the goal of WO-77. The top-right cell shows why combining caching with the existing `maxTurns` strategy is **not** sufficient: incremental eviction of one turn per fire shifts the prefix repeatedly and loses most of the cache benefit.

## When to use this hank

- You operate a long-running conversational sentinel that fires many times against a stable, growing event stream (observers over `tool.result`, log-watchers, audit loggers).
- The sentinel's history routinely climbs into the dozens of turns.
- You are paying real money to Anthropic for that sentinel and want to verify the savings before flipping the config in production.
- You want a deterministic, no-API estimator you can run in CI to prove the savings on synthetic workloads before spending on the real-API verification.

## How to run

### 1. Generate fixture files (deterministic, gitignored)

```bash
cd learning/examples/cache-aware-conversational-sentinel
bun scripts/create-fixture-files.ts --count 100 --tokens-per-file 250 --output-dir ./data/test-files
```

### 2. Run the dry-run estimator for all four cases

```bash
bun scripts/replay-sentinel-costs.ts --strategy maxTurns      --cache off --fires 100
bun scripts/replay-sentinel-costs.ts --strategy maxTurns      --cache on  --fires 100
bun scripts/replay-sentinel-costs.ts --strategy chunkedWindow --cache off --fires 100
bun scripts/replay-sentinel-costs.ts --strategy chunkedWindow --cache on  --fires 100
```

Each writes to `results/anthropic-<strategy>-cache-<on|off>.jsonl`.

### 3. Tabulate

```bash
bun scripts/compare-results.ts results/*.jsonl
```

The lowest-cost row (chunkedWindow + cache on) is marked with `← lowest` and a `vs_min` column shows the multiplier each row pays relative to it.

### 4. (Optional) Real-API verification

Opt in once, after you trust the dry-run, to spend real money confirming the estimator:

```bash
ANTHROPIC_API_KEY=... bun scripts/replay-sentinel-costs.ts \
  --strategy chunkedWindow --cache on --real-api --fires 20
```

The script will refuse to run without `ANTHROPIC_API_KEY` and writes to a `-realapi`-suffixed result file so you do not overwrite the dry-run baseline.

### 5. (Optional) Drive a real codon

If you want to replace the synthetic estimate with a real captured event stream, run the hank against the fixture directory and point `--events` at the resulting `events.jsonl`:

```bash
hankweave --config=./hank.json --data=./data/test-files
bun scripts/replay-sentinel-costs.ts --events ./.hankweave/events/events.jsonl --strategy chunkedWindow --cache on
```

The estimator will count `tool.result` events and use that as the fire count.

## Expected results

**Qualitative**, not exact dollar values — the absolute numbers depend on `--tokens-per-file`, `--system-tokens`, and Anthropic's pricing on the day you read this. Refer to the `compare-results.ts` output, not this README, for the live numbers.

- `chunkedWindow + cache on` should be the **lowest** total cost row.
- `maxTurns + cache on` can still save some money vs `maxTurns + cache off` because Anthropic's auto-prefix-checking does some work even with sliding eviction, but the prefix shifts every fire past the cap so most of the cache benefit is lost.
- `chunkedWindow + cache off` matches `maxTurns + cache off` closely — the trim strategy alone does not save money, only the cache does.
- On long, read-heavy workloads, the savings ratio approaches the provider's cached-input discount after output tokens and cache writes are included. One local production-scale diagnostic (M=70, 100 fires, ~1000 tokens/turn) measured about `$5.50` baseline versus about `$0.55` cached. Smaller workloads usually show a lower ratio because cache-write costs amortise over fewer reads; for example, a compressed local test at M=10 and 25 fires measured `chunkedWindow + cache on` at about 6.7x cheaper than `chunkedWindow + cache off`.

If the ratio is far off, check the assumptions section below.

### Multi-sentinel multiplier

The biggest operational leverage case is **N parallel sentinels asking different questions of the same long input**. This example does not implement an explicit pre-warm step, but the production pattern is:

```
await warmup();                         // 1 cache_write of the long input
await Promise.all([                     // N parallel reads of the cache
  sentinel_1(), sentinel_2(), ..., sentinel_N()
]);
```

Effective cost ≈ 1 full input + N small follow-ups, vs N full input queries without cache. **Important:** the warmup must run serially first. `Promise.all([warmup, ...sentinels])` collides — concurrent fires all write the same cache and none read.

## Caching

### Why the breakpoint sits on the last historical message (`lastMessage` strategy)

Anthropic's prompt-cache works by:

1. Caching the prompt prefix up to and including any `cache_control` marker.
2. Auto-checking ~20 content blocks BEFORE any explicit marker for previously-cached prefixes that match.

The marker placement determines where Anthropic STARTS looking for cache hits. Putting the marker on the LAST historical message means:

- Each fire's marker is "near" the prior fire's marker (within 2 messages).
- Anthropic's auto-prefix-checking reliably finds the prior cache and extends it forward.
- The system prompt + every retained turn before the new event is read from cache.
- The new live user message comes AFTER the marker and is fresh input.

**Two preconditions for this to work:**

1. **All retained user/assistant messages MUST be in parts-form**, not strings. Mixing string-form and parts-form for the same text content produces different JSON shapes in the Anthropic API request body, which breaks byte-exact prefix matching. The cache helper handles this conversion automatically at send time.

2. **The marker is required** — Anthropic does NOT auto-cache without an explicit `cache_control` hint. Tested empirically: parts-form messages with NO cache_control got zero cache hits across 25 fires.

### Why `chunkedWindow` stabilises the prefix between shifts

The existing `maxTurns: 70` strategy uses `splice(0, 2)` whenever the count exceeds 70 — it drops one turn per fire forever after fire 71. Each drop changes the prefix → cache misses every fire.

`chunkedWindow { maxTurns: 70, shiftTurns: 20 }` only prunes when the cap is exceeded, and when it does, it drops 20 turns at once. Between those rare shifts the prefix grows monotonically, so the cache from the previous fire is a **prefix** of the current one — Anthropic charges a cache **read** for the matched portion and only writes the new tail.

| Fire | Pre-LLM stored turns | What happens |
|---|---|---|
| 1   | 0  | No history, no breakpoint → no cache |
| 2-71 | grows 1→70 | Cache read of prior prefix, write of new tail (delta) |
| 72  | 71 → 51 (shift drops 20) | Cache **miss**, prefix invalidated by the front-of-window change |
| 73-91 | grows back | Cache read + incremental write |
| 92  | 71 → 51 | Cache **miss** again |

That gives you ~19 cheap fires for every 1 expensive fire, instead of one expensive fire after another in the baseline.

### How to verify caching is engaging

Watch the WebSocket event stream (or the `sentinel.output` events in `events.jsonl`):

```jsonc
{
  "type": "sentinel.output",
  "data": {
    "tokens": {
      "input": 285,                    // small — only the new event
      "output": 8,
      "cachedInputTokens": 21000,      // > 0 means the cache hit
      "cacheCreationInputTokens": 285  // small write of just the delta
    }
  }
}
```

`cachedInputTokens > 0` after fire 2 means the cache is engaging. If you see `cachedInputTokens: 0` on every fire after fire 2, the cache is silently broken — most likely the prompt prefix is changing fire-to-fire (see "Caveat" below).

### The 4096-token Haiku 4.5 cache minimum

Anthropic ephemeral caches require a minimum of **4096 tokens** of cacheable content to actually create a cache entry on Haiku 4.5. With 250-token files (≈285 tokens per turn including JSON overhead), you need roughly **15 turns of history** before the cache breakpoint covers enough tokens to be honoured.

Below that, `cacheCreationInputTokens` will be 0 every fire and you will see no savings — not because anything is broken, but because Anthropic silently declined to cache too-small a prefix. The estimator does not model this floor; in real-API mode you may see the first ~14 fires post no cache writes before the cache turns on.

Conversely, if your codon naturally clears its history every ~4 turns (say because you use `maxTurns: 4`), a 1000-token-per-turn workload will never reach the 4096-token floor and caching cannot help.

### Caveat: dynamic system prompts (Eta tags) defeat caching silently

If your sentinel system prompt contains Eta interpolations (`<%= ... %>`) over a value that changes between fires (timestamp, run id, dynamic context), the rendered system prompt will be byte-different every fire. Same prefix, different bytes → cache miss every fire, no error reported. The pre-build verification of WO-77 confirmed `implementation-observer.json` has zero Eta tags in its system prompt; the demo sentinels here also avoid them. If you see no cache hits, dump the rendered system prompt for two consecutive fires and `diff` them.

## Files

```
cache-aware-conversational-sentinel/
├── README.md                         # this file
├── hank.json                         # one codon, both sentinels attached
├── codons/
│   └── 1-read-test-files/prompt.md   # "Read every file sequentially"
├── sentinels/
│   ├── observer-maxturns.json        # baseline: maxTurns:70, no cache
│   └── observer-chunked.json         # proposed: chunkedWindow {70,20} + ephemeral cache
├── scripts/
│   ├── create-fixture-files.ts       # parameterised lorem-ipsum generator
│   ├── replay-sentinel-costs.ts      # the 4-case dry-run estimator + opt-in --real-api
│   └── compare-results.ts            # markdown table from the result JSONLs
├── data/test-files/                  # generated, gitignored
└── results/                          # generated, gitignored
```
