#!/usr/bin/env bun
/**
 * Tabulate the 4-case (or N-case) matrix of replay-sentinel-costs.ts outputs.
 *
 * Usage:
 *   bun scripts/compare-results.ts results/*.jsonl
 *
 * Reads the trailing `summary` line from each JSONL file and prints a markdown
 * table sorted by total $cost ascending. The lowest-cost row gets a "← lowest"
 * marker; the highest gets a ratio note vs. lowest.
 */

import { readFileSync } from "node:fs";

interface Summary {
  summary: true;
  strategy: string;
  cache: string;
  provider: string;
  fires: number;
  realApi?: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  _path?: string;
}

function loadSummary(path: string): Summary | null {
  const data = readFileSync(path, "utf8");
  const lines = data
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as Partial<Summary>;
      if (obj.summary === true) return { ...(obj as Summary), _path: path };
    } catch {
      /* skip */
    }
  }
  return null;
}

function pad(s: string | number, width: number): string {
  const str = String(s);
  return str + " ".repeat(Math.max(0, width - str.length));
}

function main(): void {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: bun compare-results.ts <results/*.jsonl>");
    process.exit(1);
  }
  const summaries: Summary[] = [];
  for (const p of paths) {
    const s = loadSummary(p);
    if (!s) {
      console.error(`[compare] no summary line in ${p}, skipping`);
      continue;
    }
    summaries.push(s);
  }
  if (summaries.length === 0) {
    console.error("[compare] no summaries found");
    process.exit(1);
  }
  summaries.sort((a, b) => a.costUsd - b.costUsd);
  const cheapest = summaries[0].costUsd;

  const cols = [
    { key: "strategy", w: 14 },
    { key: "cache", w: 6 },
    { key: "fires", w: 6 },
    { key: "input", w: 13 },
    { key: "cached", w: 13 },
    { key: "cacheWrite", w: 13 },
    { key: "output", w: 8 },
    { key: "$cost", w: 12 },
    { key: "vs_min", w: 8 },
  ];

  const header = cols.map((c) => pad(c.key, c.w)).join("  ");
  const rule = cols.map((c) => "-".repeat(c.w)).join("  ");
  console.log("\n" + header);
  console.log(rule);
  for (const s of summaries) {
    const ratio = s.costUsd === 0 ? "n/a" : (s.costUsd / cheapest).toFixed(2) + "x";
    const marker = s.costUsd === cheapest ? " ← lowest" : "";
    console.log(
      [
        pad(s.strategy, 14),
        pad(s.cache, 6),
        pad(s.fires, 6),
        pad(s.inputTokens, 13),
        pad(s.cachedInputTokens, 13),
        pad(s.cacheCreationInputTokens, 13),
        pad(s.outputTokens, 8),
        pad("$" + s.costUsd.toFixed(6), 12),
        pad(ratio, 8),
      ].join("  ") + marker,
    );
  }

  // Markdown version
  console.log("\n## Markdown\n");
  console.log(
    "| strategy | cache | fires | input | cached_read | cache_write | output | $cost | vs min |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    const ratio = s.costUsd === 0 ? "n/a" : (s.costUsd / cheapest).toFixed(2) + "x";
    const marker = s.costUsd === cheapest ? " ← lowest" : "";
    console.log(
      `| ${s.strategy} | ${s.cache} | ${s.fires} | ${s.inputTokens} | ${s.cachedInputTokens} | ${s.cacheCreationInputTokens} | ${s.outputTokens} | $${s.costUsd.toFixed(6)} | ${ratio}${marker} |`,
    );
  }
}

main();
