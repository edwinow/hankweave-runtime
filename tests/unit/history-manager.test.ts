import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HistoryManager, simpleTokenCounter } from "../../server/sentinels/history-manager";
import { CodonId } from "../../server/types/branded-types";
import { Logger } from "../../server/utils";

// Mock logger for testing
class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  constructor() {
    super("/dev/null"); // Use a dummy file path
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }
}

describe("HistoryManager", () => {
  let testDir: string;
  let logger: MockLogger;

  beforeEach(async () => {
    // Create a temporary directory for testing
    const tempBase = tmpdir();
    testDir = path.join(tempBase, `test-sentinels-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    logger = new MockLogger();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Basic Operations", () => {
    test("should create a HistoryManager and add message pairs", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Hello, how are you?", "I'm doing well, thank you!");
      const messages = await historyManager.getMessagesToSend("You are a helpful assistant.");

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({
        role: "system",
        content: "You are a helpful assistant.",
      });
      expect(messages[1]).toEqual({
        role: "user",
        content: "Hello, how are you?",
      });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "I'm doing well, thank you!",
      });
    });

    test("should handle multiple conversation turns", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("First question", "First answer");
      await historyManager.addMessagePair("Second question", "Second answer");

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(5); // system + 2 pairs
    });
  });

  describe("History Loading", () => {
    test("should load history from existing file", async () => {
      // Create a pre-populated history file with codon-scoped naming
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const existingHistory = [
        { role: "user", content: "Previous question" },
        { role: "assistant", content: "Previous answer" },
      ];
      await fs.writeFile(historyPath, JSON.stringify(existingHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3); // system + user + assistant
      expect(messages[1]).toEqual({
        role: "user",
        content: "Previous question",
      });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "Previous answer",
      });
    });

    test("should handle invalid history file", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      await fs.writeFile(historyPath, "invalid json");

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      // Should start fresh
      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(1); // Only system prompt
    });
  });

  describe("maxTurns Pruning", () => {
    test("should prune old turns when exceeding maxTurns", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 2 },
        testDir,
        logger,
      );

      // Add 3 turns
      await historyManager.addMessagePair("Turn 1 user", "Turn 1 assistant");
      await historyManager.addMessagePair("Turn 2 user", "Turn 2 assistant");
      await historyManager.addMessagePair("Turn 3 user", "Turn 3 assistant");

      const messages = await historyManager.getMessagesToSend("System prompt");

      // Should only have system + 2 most recent turns (5 messages total)
      expect(messages).toHaveLength(5); // system + 2 turns * 2
      expect(messages[1]).toEqual({
        role: "user",
        content: "Turn 2 user",
      });
      expect(messages[3]).toEqual({
        role: "user",
        content: "Turn 3 user",
      });
    });
  });

  describe("maxTokens Pruning", () => {
    test("should prune old messages when exceeding maxTokens", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTokens", maxTokens: 20 }, // ~80 chars
        testDir,
        logger,
      );

      // Add messages that exceed token limit
      await historyManager.addMessagePair(
        "This is a very long message with many characters that will exceed our limit",
        "This is another very long message with even more characters",
      );
      await historyManager.addMessagePair("Short msg", "Another short");

      const messages = await historyManager.getMessagesToSend("System prompt");

      // Should have pruned oldest messages to stay under limit
      expect(messages.length).toBeLessThanOrEqual(3); // System + some recent messages

      // Verify last message is the most recent
      const lastMessage = messages[messages.length - 1];
      expect(lastMessage.content).toBe("Another short");
    });

    test("should calculate tokens correctly", () => {
      expect(simpleTokenCounter("1234")).toBe(1);
      expect(simpleTokenCounter("12345")).toBe(2);
      expect(simpleTokenCounter("12345678")).toBe(2);
      expect(simpleTokenCounter("123456789")).toBe(3);
    });
  });

  describe("Memory-Only Mode", () => {
    test("should work without directory (memory-only mode)", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        undefined, // No directory
        logger,
      );

      await historyManager.addMessagePair("Message 1", "Response 1");

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3);

      // Check that no file was created (using codon-scoped naming)
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      await expect(fs.access(historyPath)).rejects.toThrow();
    });
  });

  describe("Persistence and Recovery", () => {
    test("should save history after message pair addition", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Question", "Answer");

      // Check that file was created (with codon-scoped naming)
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const content = await fs.readFile(historyPath, "utf-8");
      const savedHistory = JSON.parse(content);

      expect(savedHistory).toHaveLength(2);
      // New format stores {message, tokens} objects
      expect(savedHistory[0]).toEqual({
        message: {
          role: "user",
          content: "Question",
        },
        tokens: undefined,
      });
      expect(savedHistory[1]).toEqual({
        message: {
          role: "assistant",
          content: "Answer",
        },
        tokens: undefined,
      });
    });

    test("should use atomic writes", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Question", "Answer");

      // Temp file should not exist after successful write (codon-scoped naming)
      const tempPath = path.join(testDir, "test-sentinel-codon-test-codon.json.tmp");
      await expect(fs.access(tempPath)).rejects.toThrow();
    });

    test("should recover history across instances", async () => {
      // First instance
      const historyManager1 = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager1.addMessagePair("Question 1", "Answer 1");

      // Second instance
      const historyManager2 = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager2.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3);
      expect(messages[1].content).toBe("Question 1");
      expect(messages[2].content).toBe("Answer 1");
    });
  });

  describe("Message Type Validation", () => {
    test("should filter out invalid messages when loading", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      // Use only 1 invalid message (< 20% corruption threshold: 1/9 = 11%)
      const mixedHistory = [
        { role: "user", content: "Valid user message 1" },
        { role: "assistant", content: "Valid assistant message 1" },
        { role: "user", content: "Valid user message 2" },
        { role: "assistant", content: "Valid assistant message 2" },
        { role: "user", content: "Valid user message 3" },
        { role: "assistant", content: "Valid assistant message 3" },
        { role: "user", content: "Valid user message 4" },
        { role: "assistant", content: "Valid assistant message 4" },
        { invalid: "structure" }, // Only 1 invalid message = 11% corruption
      ];
      await fs.writeFile(historyPath, JSON.stringify(mixedHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      // Should have system + 8 valid messages (1 invalid filtered out)
      expect(messages).toHaveLength(9); // system + 4 valid turns
      expect(messages[1].role).toBe("user");
      expect(messages[2].role).toBe("assistant");

      // Verify error logging occurred for invalid messages
      const errorLogs = logger.logs.filter((log) => log.level === "error");
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  describe("System Prompt Handling", () => {
    test("should always include fresh system prompt as first message", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Question", "Answer");

      // First call with one system prompt
      const messages1 = await historyManager.getMessagesToSend("System prompt 1");
      expect(messages1[0]).toEqual({
        role: "system",
        content: "System prompt 1",
      });

      // Second call with different system prompt
      const messages2 = await historyManager.getMessagesToSend("System prompt 2");
      expect(messages2[0]).toEqual({
        role: "system",
        content: "System prompt 2",
      });
    });
  });

  describe("Skip Pruning Option", () => {
    test("should skip pruning when requested", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 1 },
        testDir,
        logger,
      );

      // Add 2 turns (exceeds max)
      await historyManager.addMessagePair("Turn 1 user", "Turn 1 assistant");
      await historyManager.addMessagePair("Turn 2 user", "Turn 2 assistant");

      // Get messages without pruning
      const messages = await historyManager.getMessagesToSend("System prompt", true);

      // Should have all messages
      expect(messages).toHaveLength(5); // system + 2 complete turns
    });
  });

  describe("Token Count Storage", () => {
    test("should store actual token counts when provided", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      // Add message pair with token counts
      await historyManager.addMessagePair("Question", "Answer", 100, 50);

      // Verify tokens were saved in file
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const content = await fs.readFile(historyPath, "utf-8");
      const savedHistory = JSON.parse(content);

      expect(savedHistory[0].tokens).toBe(100);
      expect(savedHistory[1].tokens).toBe(50);
    });

    test("should use actual token counts for pruning when available", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTokens", maxTokens: 40 }, // Threshold to trigger pruning
        testDir,
        logger,
      );

      // Add messages with explicit token counts
      await historyManager.addMessagePair("Message 1", "Response 1", 60, 50); // 110 total - way over
      await historyManager.addMessagePair("Message 2", "Response 2", 15, 10); // 25 total - fits

      const messages = await historyManager.getMessagesToSend("System prompt");

      // With 135 tokens total and maxTokens of 40:
      // - Prunes until under 40
      // - Removes Message 1 (60 tokens) → 75 tokens remaining
      // - Removes Response 1 (50 tokens) → 25 tokens remaining
      // - Keeps Message 2 (15) + Response 2 (10) = 25 tokens ✓
      expect(messages).toHaveLength(3); // system + 1 pair
      expect(messages[1].content).toBe("Message 2");
      expect(messages[2].content).toBe("Response 2");
    });

    test("should handle backward compatibility with old format (no tokens)", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const oldFormatHistory = [
        { role: "user", content: "Old format user" },
        { role: "assistant", content: "Old format assistant" },
      ];
      await fs.writeFile(historyPath, JSON.stringify(oldFormatHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3);
      expect(messages[1].content).toBe("Old format user");
    });
  });

  describe("Corruption Detection", () => {
    test("should detect and handle high corruption rate (>20%)", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      // 3 invalid out of 5 = 60% corruption (exceeds 20% threshold)
      const corruptHistory = [
        { role: "user", content: "Valid message" },
        { invalid: "structure 1" },
        { invalid: "structure 2" },
        { role: "assistant", content: "Valid response" },
        { invalid: "structure 3" },
      ];
      await fs.writeFile(historyPath, JSON.stringify(corruptHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      // Should start fresh due to high corruption
      expect(messages).toHaveLength(1); // Only system prompt

      // Verify corruption was logged
      const corruptionLogs = logger.logs.filter(
        (log) => log.level === "error" && log.message.includes("60.0%"),
      );
      expect(corruptionLogs.length).toBeGreaterThan(0);
    });

    test("should handle low corruption rate (<20%) gracefully", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      // 1 invalid out of 10 = 10% corruption (under threshold)
      const slightlyCorruptHistory = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Response 2" },
        { role: "user", content: "Message 3" },
        { role: "assistant", content: "Response 3" },
        { role: "user", content: "Message 4" },
        { role: "assistant", content: "Response 4" },
        { role: "user", content: "Message 5" },
        { invalid: "one bad message" }, // 10% corruption
      ];
      await fs.writeFile(historyPath, JSON.stringify(slightlyCorruptHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      // Should load valid messages despite corruption
      expect(messages).toHaveLength(10); // system + 9 valid messages (1 filtered)

      // Verify corruption percentage was logged at "error" level (not "info")
      const corruptionLogs = logger.logs.filter(
        (log) => log.level === "error" && log.message.includes("10.0%"),
      );
      expect(corruptionLogs.length).toBeGreaterThan(0);
    });
  });

  describe("Structured Output Support", () => {
    test("should accept objects in addMessagePair and stringify them", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const userObj = { query: "test" };
      const assistantObj = { result: "success", count: 42 };

      await historyManager.addMessagePair(userObj, assistantObj, 10, 20);

      const messages = await historyManager.getMessagesToSend("System");
      expect(messages[1].content).toBe(JSON.stringify(userObj));
      expect(messages[2].content).toBe(JSON.stringify(assistantObj));
    });

    test("should handle mixed string and object history", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("string user", "string assistant");
      await historyManager.addMessagePair({ obj: "user" }, { obj: "assistant" });

      const messages = await historyManager.getMessagesToSend("System");
      expect(messages[1].content).toBe("string user");
      expect(messages[3].content).toBe('{"obj":"user"}');
    });
  });

  describe("chunkedWindow Pruning", () => {
    /**
     * Simulate one full sentinel-call cycle:
     * 1. getMessagesToSend(systemPrompt) — fires prune() pre-LLM
     * 2. addMessagePair(...) — appends one new turn after the LLM responds
     *
     * Returns the user-message count from the prepared message array (not history)
     * so we can assert what prune() retained at LLM-call time.
     */
    async function fireOnce(
      hm: HistoryManager,
      n: number,
    ): Promise<{ messageCount: number; userCount: number }> {
      const messages = await hm.getMessagesToSend("S");
      const userCount = messages.filter((m) => m.role === "user").length;
      await hm.addMessagePair(`user ${n}`, `asst ${n}`);
      return { messageCount: messages.length, userCount };
    }

    test("backwards compat — existing maxTurns:50 unchanged", async () => {
      const hm = new HistoryManager(
        "compat",
        CodonId("c1"),
        { type: "maxTurns", maxTurns: 50 },
        testDir,
        logger,
      );
      // Fire 60 times. After 60 calls history holds 60 turns (120 messages),
      // but prune at fire 51 onwards keeps it at 50 turns.
      for (let i = 1; i <= 60; i++) await fireOnce(hm, i);
      const messages = await hm.getMessagesToSend("S");
      // System + 50 turns * 2 = 101
      expect(messages.length).toBe(101);
    });

    test("boundary: shift fires at fire 72 for {maxTurns:70, shiftTurns:20}", async () => {
      const hm = new HistoryManager(
        "boundary",
        CodonId("c1"),
        { type: "chunkedWindow", maxTurns: 70, shiftTurns: 20 },
        testDir,
        logger,
      );

      // Fire 71 times. At fire 71, pre-LLM history has 70 turns; 70 > 70 is false → no shift.
      // After fire 71, post-LLM history has 71 turns.
      for (let i = 1; i <= 71; i++) await fireOnce(hm, i);
      // Pre-LLM at fire 72: 71 stored turns → prune sees 71 > 70 → shift!
      // Drops 20 turns → 51 retained pre-LLM.
      const fire72 = await fireOnce(hm, 72);
      // userCount in messages array (excluding system) reflects retained turns at LLM call time.
      expect(fire72.userCount).toBe(51);
      // System + 51 turns * 2 = 103
      expect(fire72.messageCount).toBe(103);

      // Sanity: at fire 71 there should be no shift (70 stored turns pre-LLM).
      const hm2 = new HistoryManager(
        "boundary2",
        CodonId("c2"),
        { type: "chunkedWindow", maxTurns: 70, shiftTurns: 20 },
        testDir,
        logger,
      );
      for (let i = 1; i <= 70; i++) await fireOnce(hm2, i);
      const fire71 = await fireOnce(hm2, 71);
      // Pre-LLM at fire 71: 70 turns → 70 > 70 false → no shift, 70 retained.
      expect(fire71.userCount).toBe(70);
    });

    test("multiple shifts: fires happen at 72, 92, 112 for {70, 20}", async () => {
      const hm = new HistoryManager(
        "multi",
        CodonId("c1"),
        { type: "chunkedWindow", maxTurns: 70, shiftTurns: 20 },
        testDir,
        logger,
      );
      const userCounts: number[] = [];
      for (let i = 1; i <= 130; i++) {
        const r = await fireOnce(hm, i);
        userCounts.push(r.userCount);
      }
      // Shifts at fires 72, 92, 112 — at those calls prune drops 20 turns.
      // Pre-shift at fire 72: 71 → post-shift 51. Pre-shift fire 92: 71 → 51.
      expect(userCounts[71]).toBe(51); // index 71 = fire 72
      expect(userCounts[91]).toBe(51); // index 91 = fire 92
      expect(userCounts[111]).toBe(51); // index 111 = fire 112
      // Between shifts, count grows by 1 per fire (no prune on those).
      expect(userCounts[72]).toBe(52); // fire 73
      expect(userCounts[80]).toBe(60); // fire 81
      expect(userCounts[90]).toBe(70); // fire 91 (pre-shift again)
    });

    test("edge case: shiftTurns=1 (sliding stride-1 once over cap)", async () => {
      const hm = new HistoryManager(
        "stride1",
        CodonId("c1"),
        { type: "chunkedWindow", maxTurns: 5, shiftTurns: 1 },
        testDir,
        logger,
      );
      const userCounts: number[] = [];
      for (let i = 1; i <= 10; i++) {
        const r = await fireOnce(hm, i);
        userCounts.push(r.userCount);
      }
      // Fire 6: pre-LLM has 5 turns → 5 > 5 false → 5 retained.
      // Fire 7: pre-LLM has 6 turns → 6 > 5 true → drop 1 → 5 retained.
      // From fire 7 onward, retained stays at 5.
      expect(userCounts[5]).toBe(5); // fire 6
      expect(userCounts[6]).toBe(5); // fire 7 (post-shift)
      expect(userCounts[9]).toBe(5); // fire 10
    });

    test("edge case: shiftTurns === maxTurns (full window flush each time)", async () => {
      const hm = new HistoryManager(
        "fullflush",
        CodonId("c1"),
        { type: "chunkedWindow", maxTurns: 5, shiftTurns: 5 },
        testDir,
        logger,
      );
      const userCounts: number[] = [];
      for (let i = 1; i <= 12; i++) {
        const r = await fireOnce(hm, i);
        userCounts.push(r.userCount);
      }
      // Fire 6: pre-LLM has 5 → 5 > 5 false → 5 retained.
      // Fire 7: pre-LLM has 6 → 6 > 5 true → drop 5 → 1 retained.
      // Fire 8: pre-LLM has 2 → no shift → 2 retained.
      // ... grows until fire 12: pre-LLM has 6 → drop 5 → 1 retained.
      expect(userCounts[5]).toBe(5); // fire 6
      expect(userCounts[6]).toBe(1); // fire 7 (full-window shift)
      expect(userCounts[7]).toBe(2); // fire 8
      expect(userCounts[11]).toBe(1); // fire 12 (next full-window shift)
    });

    test("shift log fires at the right call", async () => {
      const hm = new HistoryManager(
        "log",
        CodonId("c1"),
        { type: "chunkedWindow", maxTurns: 3, shiftTurns: 2 },
        testDir,
        logger,
      );
      logger.logs = [];
      for (let i = 1; i <= 4; i++) await fireOnce(hm, i);
      // Fire 4: pre-LLM has 3 turns → no shift.
      const shiftLogsBefore = logger.logs.filter((l) => l.message.includes("chunkedWindow shift"));
      expect(shiftLogsBefore.length).toBe(0);
      // Fire 5: pre-LLM has 4 → 4 > 3 → shift, drop 2.
      await fireOnce(hm, 5);
      const shiftLogsAfter = logger.logs.filter((l) => l.message.includes("chunkedWindow shift"));
      expect(shiftLogsAfter.length).toBe(1);
    });
  });
});
