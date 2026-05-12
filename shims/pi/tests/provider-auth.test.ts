import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatMissingApiKeyMessage,
  getProviderCredentialStatus,
  shouldEnforceProviderCredential,
} from "../src/provider-auth.js";

const envKeys = [
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
});

describe("Pi provider auth modes", () => {
  test("keeps openai-codex on stored auth rather than OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-local-openai";

    const status = getProviderCredentialStatus("openai-codex");
    expect(status.envVars).toEqual([]);

    const message = formatMissingApiKeyMessage("openai-codex");
    expect(message).toContain("Missing stored authentication");
    expect(message).toContain("OPENAI_API_KEY is only used for the openai provider");
  });

  test("preserves env-backed status for ordinary OpenAI provider", () => {
    expect(getProviderCredentialStatus("openai")).toEqual({
      available: false,
      apiKeySource: "none",
      envVars: ["OPENAI_API_KEY"],
    });

    process.env.OPENAI_API_KEY = "sk-local-openai";

    expect(getProviderCredentialStatus("openai")).toEqual({
      available: true,
      apiKeySource: "env",
      envVars: ["OPENAI_API_KEY"],
    });
  });

  test("continues to enforce only known providers", () => {
    expect(shouldEnforceProviderCredential("openai-codex")).toBe(true);
    expect(shouldEnforceProviderCredential("some-new-provider")).toBe(false);
    expect(getProviderCredentialStatus("some-new-provider")).toEqual({
      available: true,
      apiKeySource: "none",
      envVars: [],
    });
  });
});
