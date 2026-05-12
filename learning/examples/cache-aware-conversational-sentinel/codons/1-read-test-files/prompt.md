You are running a sentinel-cache demonstration. Your only job is to generate a long, deterministic stream of tool-result events so the attached observer sentinels accumulate ~100 turns of conversational history.

## Instructions

1. List the files in `./data/test-files/` (one `LS` or `Bash ls` call).
2. Read every file in `./data/test-files/` **sequentially, NOT in parallel** — exactly one `Read` tool call per file, in lexicographic order.
3. After each file, do **not** summarise, do **not** comment, do **not** plan. Immediately issue the next `Read` call.
4. When all files have been read, output a single line: `done`.

## Why this shape

Each `Read` produces a `tool.result` event. The attached observer sentinels are configured to fire on every `tool.result`, so reading N files yields N sentinel fires with monotonically growing conversational history. This is the workload the cache savings are measured against.

Do not deviate. Do not optimise. Do not parallelise. One file per Read, in order, until done.
