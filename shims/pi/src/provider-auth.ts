import { AuthStorage } from "@mariozechner/pi-coding-agent";

export interface ProviderCredentialStatus {
  available: boolean;
  apiKeySource: string;
  envVars: readonly string[];
}

interface ProviderCredentialConfig {
  envVars: readonly string[];
  apiKeySource: string;
  runtimeProvider: string;
  useStoredAuth?: boolean;
  missingAuthMessage?: string;
}

const PROVIDER_CREDENTIALS: Record<string, ProviderCredentialConfig> = {
  anthropic: {
    envVars: ["ANTHROPIC_API_KEY"],
    apiKeySource: "ANTHROPIC_API_KEY",
    runtimeProvider: "anthropic",
  },
  google: {
    envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "google",
  },
  openai: {
    envVars: ["OPENAI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "openai",
  },
  "openai-codex": {
    envVars: [],
    apiKeySource: "stored",
    runtimeProvider: "openai-codex",
    useStoredAuth: true,
    missingAuthMessage:
      "Authenticate with Pi's stored openai-codex provider credentials; OPENAI_API_KEY is only used for the openai provider.",
  },
  openrouter: {
    envVars: ["OPENROUTER_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "openrouter",
  },
};

function getConfiguredEnvValue(envVars: readonly string[]): string | undefined {
  for (const envVar of envVars) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function hasConfiguredEnvValue(envVars: readonly string[]): boolean {
  return getConfiguredEnvValue(envVars) !== undefined;
}

export function configureAuthStorage(): AuthStorage {
  const authStorage = AuthStorage.create();

  for (const config of Object.values(PROVIDER_CREDENTIALS)) {
    if (config.useStoredAuth) {
      continue;
    }

    const value = getConfiguredEnvValue(config.envVars);
    if (value) {
      authStorage.setRuntimeApiKey(config.runtimeProvider, value);
    }
  }

  return authStorage;
}

export function getKnownApiKeyStatus(): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(PROVIDER_CREDENTIALS).map(([provider, config]) => {
      if (config.useStoredAuth) {
        return [provider, AuthStorage.create().getAuthStatus(config.runtimeProvider).configured];
      }

      return [provider, hasConfiguredEnvValue(config.envVars)];
    }),
  );
}

export function getProviderCredentialStatus(provider: string): ProviderCredentialStatus {
  const normalizedProvider = provider.toLowerCase();
  const config = PROVIDER_CREDENTIALS[normalizedProvider];

  if (!config) {
    const hasAnyKnownKey = Object.values(PROVIDER_CREDENTIALS).some((entry) =>
      hasConfiguredEnvValue(entry.envVars),
    );

    return {
      available: true,
      apiKeySource: hasAnyKnownKey ? "env" : "none",
      envVars: [],
    };
  }

  if (config.useStoredAuth) {
    const stored = AuthStorage.create().getAuthStatus(config.runtimeProvider);
    return {
      available: stored.configured,
      apiKeySource: stored.configured ? (stored.source ?? config.apiKeySource) : "none",
      envVars: config.envVars,
    };
  }

  const available = hasConfiguredEnvValue(config.envVars);
  return {
    available,
    apiKeySource: available ? config.apiKeySource : "none",
    envVars: config.envVars,
  };
}

export function shouldEnforceProviderCredential(provider: string): boolean {
  return provider.toLowerCase() in PROVIDER_CREDENTIALS;
}

export function formatMissingApiKeyMessage(provider: string): string {
  const config = PROVIDER_CREDENTIALS[provider.toLowerCase()];
  if (config?.useStoredAuth) {
    return `Missing stored authentication for provider '${provider}'. ${config.missingAuthMessage ?? "Authenticate with Pi's stored provider credentials."}`;
  }

  const status = getProviderCredentialStatus(provider);
  if (status.envVars.length === 0) {
    return `Missing API key for provider '${provider}'.`;
  }

  return `Missing API key for provider '${provider}'. Set ${status.envVars.join(" or ")}.`;
}
