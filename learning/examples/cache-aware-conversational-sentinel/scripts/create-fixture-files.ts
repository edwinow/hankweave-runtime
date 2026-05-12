#!/usr/bin/env bun
/**
 * Generate deterministic fixture files for the cache-aware-conversational-sentinel demo.
 *
 * Usage:
 *   bun scripts/create-fixture-files.ts \
 *     --count 100 \
 *     --tokens-per-file 250 \
 *     --output-dir ./data/test-files
 *
 * Each file contains roughly the requested number of tokens (using a
 * ~4-chars-per-token heuristic) of repeating, seeded lorem-ipsum-style content.
 * Output is fully deterministic given the same `--count` and `--tokens-per-file`
 * so repeated runs produce identical bytes (important for the dry-run estimator
 * which assumes byte-stable history).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Args {
  count: number;
  tokensPerFile: number;
  outputDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    count: 100,
    tokensPerFile: 250,
    outputDir: "./data/test-files",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--count" && next) {
      args.count = parseInt(next, 10);
      i++;
    } else if (a === "--tokens-per-file" && next) {
      args.tokensPerFile = parseInt(next, 10);
      i++;
    } else if (a === "--output-dir" && next) {
      args.outputDir = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun create-fixture-files.ts [--count N] [--tokens-per-file M] [--output-dir DIR]",
      );
      process.exit(0);
    }
  }
  if (
    !Number.isFinite(args.count) ||
    args.count < 1 ||
    !Number.isFinite(args.tokensPerFile) ||
    args.tokensPerFile < 1
  ) {
    throw new Error("--count and --tokens-per-file must be positive integers");
  }
  return args;
}

// Tiny deterministic PRNG (mulberry32) — same input, same output, no seed file.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "magna",
  "aliqua",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "proident",
  "sunt",
  "culpa",
  "officia",
  "deserunt",
  "mollit",
  "anim",
  "est",
];

function generateContent(fileIndex: number, tokens: number): string {
  // Seed each file with its index so files differ but are reproducible.
  const rand = mulberry32(0xc0ffee + fileIndex * 1009);
  const words: string[] = [`# fixture-${fileIndex.toString().padStart(4, "0")}`, ""];
  // Approx 1 word == 1 token. Generate tokens-1 words after the heading line.
  for (let i = 0; i < tokens - 1; i++) {
    words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
    if (i > 0 && i % 12 === 0) words.push("\n");
  }
  return words.join(" ") + "\n";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outputDir, { recursive: true });
  const pad = String(args.count).length;
  for (let i = 0; i < args.count; i++) {
    const name = `file-${String(i).padStart(pad, "0")}.txt`;
    const content = generateContent(i, args.tokensPerFile);
    writeFileSync(join(args.outputDir, name), content, "utf8");
  }
  console.log(
    `Wrote ${args.count} files of ~${args.tokensPerFile} tokens each to ${args.outputDir}`,
  );
}

main();
