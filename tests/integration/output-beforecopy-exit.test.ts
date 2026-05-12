import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCodonSequence } from "../../server/config.js";
import { HankweaveRuntime } from "../../server/hankweave-runtime.js";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { HankweaveState } from "../../server/types/state-types.js";

const TEST_DIR = path.resolve("tests", "test-area", "output-beforecopy-exit");
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "msg_beforecopyfailure1";
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY",
  "HANKWEAVE_SENTINEL_OPENAI_API_KEY",
  "HANKWEAVE_SENTINEL_GOOGLE_API_KEY",
  "HANKWEAVE_SENTINEL_GROQ_API_KEY",
] as const;

let savedProviderEnv: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>> = {};

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSyntheticReplayExecution(executionPath: string): void {
  const runId = "source-run";
  const runDir = path.join(executionPath, ".hankweave", "runs", runId);
  const logPath = path.join(runDir, "copy-failure-claude.log");
  fs.mkdirSync(runDir, { recursive: true });

  const replayLines = [
    {
      type: "system",
      subtype: "init",
      cwd: path.join(executionPath, "agentRoot"),
      session_id: SESSION_ID,
      tools: ["Write"],
      mcp_servers: [],
      model: "claude-haiku-4-5",
      permissionMode: "bypassPermissions",
      apiKeySource: "none",
      timestamp: "2026-05-12T00:00:00.000Z",
    },
    {
      type: "assistant",
      message: {
        id: MESSAGE_ID,
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "synthetic success" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      },
      session_id: SESSION_ID,
      timestamp: "2026-05-12T00:00:00.010Z",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 20,
      duration_api_ms: 20,
      num_turns: 1,
      result: "synthetic success",
      session_id: SESSION_ID,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      timestamp: "2026-05-12T00:00:00.020Z",
    },
  ];

  fs.writeFileSync(logPath, `${replayLines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  writeJson(path.join(executionPath, ".hankweave", "state.json"), {
    runs: [
      {
        runId,
        runFolder: runDir,
        gitBranch: "run-source",
        startingConditions: { type: "fresh" },
        codons: [
          {
            codonId: "copy-failure",
            startTime: "2026-05-12T00:00:00.000Z",
            status: "completed",
            claudePid: 900001,
            claudeLogPath: ".hankweave/runs/source-run/copy-failure-claude.log",
            claudeSessionId: SESSION_ID,
            currentCost: 0,
            currentTokens: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            assistantMessageCount: 1,
            extensionCount: 0,
            endTime: "2026-05-12T00:00:00.020Z",
            exitCode: 0,
            finalCost: 0,
            finalTokens: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            resultMessageReceived: true,
            completionCheckpoint: "synthetic-checkpoint",
          },
        ],
        status: "completed",
        startTime: "2026-05-12T00:00:00.000Z",
        serverPid: 900000,
        endTime: "2026-05-12T00:00:00.020Z",
      },
    ],
    currentRunId: null,
    executionPlan: [],
  });
}

async function waitForExitCode(getExitCode: () => number | undefined): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const exitCode = getExitCode();
    if (exitCode !== undefined) return exitCode;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for runtime process.exit");
}

describe("outputFiles.beforeCopy failure propagation", () => {
  beforeEach(() => {
    savedProviderEnv = {};
    for (const key of PROVIDER_ENV_KEYS) {
      savedProviderEnv[key] = process.env[key];
      delete process.env[key];
    }
    LlmProviderRegistry.resetInstance();

    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    for (const key of PROVIDER_ENV_KEYS) {
      const value = savedProviderEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    LlmProviderRegistry.resetInstance();
  });

  test("headless runtime exits 1 and marks run failed when beforeCopy fails after codon success", async () => {
    const executionPath = path.join(TEST_DIR, "execution");
    const agentRootPath = path.join(executionPath, "agentRoot");
    const dataPath = path.join(TEST_DIR, "data");
    const outputPath = path.join(TEST_DIR, "output");
    const hankPath = path.join(TEST_DIR, "hank.json");

    fs.mkdirSync(agentRootPath, { recursive: true });
    fs.mkdirSync(dataPath, { recursive: true });
    fs.mkdirSync(outputPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, "input.txt"), "synthetic input\n");

    writeSyntheticReplayExecution(executionPath);
    writeJson(hankPath, {
      hank: [
        {
          id: "copy-failure",
          name: "Copy Failure",
          promptText: "Replay supplies the successful model response.",
          model: "haiku",
          continuationMode: "fresh",
          outputFiles: [
            {
              copy: ["artifact.txt"],
              beforeCopy: [
                {
                  type: "command",
                  command: {
                    run: "node -e \"process.exit(1)\"",
                    workingDirectory: "project",
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const { codons } = loadCodonSequence({ configPath: hankPath });
    const runtime = new HankweaveRuntime({
      cwd: TEST_DIR,
      configPath: hankPath,
      readOnlySourceDataPath: dataPath,
      executionPath,
      agentRootPath,
      rigArchivePath: path.join(executionPath, "rigArchive"),
      dataPathInExecutionDir: path.join(agentRootPath, "read_only_data_source"),
      dataHash: "synthetic",
      isNewExecution: true,
      isResuming: false,
      linkType: "copy",
      codons,
      outputDirectory: outputPath,
      overwriteOutput: true,
      replayDir: executionPath,
      port: 0,
      withoutProxy: true,
      autostart: true,
    });

    const events: ServerEvent[] = [];
    runtime.on("event", (event) => events.push(event));

    const originalExit = process.exit;
    let observedExitCode: number | undefined;
    process.exit = ((code?: string | number | null | undefined) => {
      observedExitCode = typeof code === "number" ? code : Number(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;

    try {
      await runtime.start();
      await runtime.requestAutostart();

      const exitCode = await waitForExitCode(() => observedExitCode);
      expect(exitCode).toBe(1);
    } finally {
      process.exit = originalExit;
      if (observedExitCode === undefined) {
        await runtime.shutdown("test cleanup", false);
      }
    }

    const state = JSON.parse(
      fs.readFileSync(path.join(executionPath, ".hankweave", "state.json"), "utf-8"),
    ) as HankweaveState;
    expect(state.runs[0].status).toBe("failed");
    expect(state.currentRunId).toBeNull();

    const errorEvent = events.find(
      (event) =>
        event.type === "error" &&
        "context" in event.data &&
        event.data.context === "codonOutputBeforeCopy",
    );
    expect(errorEvent).toBeDefined();
  }, 45_000);
});
