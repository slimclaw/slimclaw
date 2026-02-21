import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SlimClawConfig } from "../src/config.js";

// Create a temp dir for a test, returns path + cleanup function
export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "slimclaw-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true }) };
}

// Create a minimal config for testing
export function testConfig(overrides?: Partial<SlimClawConfig>): SlimClawConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    maxTokens: 1024,
    port: 0,
    host: "127.0.0.1",
    maxHistoryTurns: 50,
    maxToolResultChars: 100_000,
    skillsDir: "./skills",
    mcp: { servers: {} },
    memoryDir: "./memory",
    memoryFile: "MEMORY.md",
    heartbeat: { enabled: false, intervalMinutes: 30 },
    ...overrides,
  };
}
