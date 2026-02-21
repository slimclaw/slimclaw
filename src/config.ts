import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface SlimClawConfig {
  // LLM
  provider: "anthropic" | "openai";
  model: string;
  apiKey?: string;
  maxTokens: number;

  // Server
  port: number;
  host: string;

  // Agent
  systemPrompt?: string;
  maxHistoryTurns: number;
  maxToolResultChars: number;

  // Skills
  skillsDir: string;

  // MCP
  mcp: {
    servers: Record<
      string,
      {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
      }
    >;
  };

  // Memory
  memoryDir: string;
  memoryFile: string;

  // Heartbeat
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    activeHours?: { start: string; end: string };
  };
}

const DEFAULTS: SlimClawConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  maxTokens: 4096,
  port: 3000,
  host: "127.0.0.1",
  maxHistoryTurns: 50,
  maxToolResultChars: 100_000,
  skillsDir: "./skills",
  mcp: { servers: {} },
  memoryDir: "./memory",
  memoryFile: "MEMORY.md",
  heartbeat: {
    enabled: false,
    intervalMinutes: 30,
  },
};

/** Infer provider from model name. */
function detectProvider(model: string): "anthropic" | "openai" {
  if (model.startsWith("claude")) return "anthropic";
  if (
    model.startsWith("gpt") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  ) {
    return "openai";
  }
  return "anthropic";
}

/** Resolve API key from config or environment variable. */
function resolveApiKey(
  provider: "anthropic" | "openai",
  configKey?: string,
): string | undefined {
  if (configKey) return configKey;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  return process.env.OPENAI_API_KEY;
}

/**
 * Load configuration from a JSON file, merge with defaults, and resolve
 * provider + API key from environment.
 */
export function loadConfig(configPath?: string): SlimClawConfig {
  const resolvedPath = resolve(configPath ?? "slimclaw.json");

  let fileConfig: Partial<SlimClawConfig> = {};
  if (existsSync(resolvedPath)) {
    const raw = readFileSync(resolvedPath, "utf-8");
    fileConfig = JSON.parse(raw) as Partial<SlimClawConfig>;
  }

  // Merge: file config over defaults (shallow for top-level, deep for nested objects)
  const merged: SlimClawConfig = {
    ...DEFAULTS,
    ...fileConfig,
    mcp: {
      ...DEFAULTS.mcp,
      ...fileConfig.mcp,
    },
    heartbeat: {
      ...DEFAULTS.heartbeat,
      ...fileConfig.heartbeat,
    },
  };

  // Auto-detect provider from model name if not explicitly set
  if (!fileConfig.provider) {
    merged.provider = detectProvider(merged.model);
  }

  // Resolve API key from env if not in config
  merged.apiKey = resolveApiKey(merged.provider, merged.apiKey);

  return merged;
}
