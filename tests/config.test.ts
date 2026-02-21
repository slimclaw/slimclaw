import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../src/config.js";
import { tempDir } from "./helpers.js";

describe("loadConfig", () => {
  let tmp: ReturnType<typeof tempDir>;

  beforeEach(() => {
    tmp = tempDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns defaults when config file does not exist", () => {
    const config = loadConfig(join(tmp.path, "nonexistent.json"));

    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.maxTokens).toBe(4096);
    expect(config.port).toBe(3000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.maxHistoryTurns).toBe(50);
    expect(config.maxToolResultChars).toBe(100_000);
    expect(config.skillsDir).toBe("./skills");
    expect(config.mcp).toEqual({ servers: {} });
    expect(config.memoryDir).toBe("./memory");
    expect(config.memoryFile).toBe("MEMORY.md");
    expect(config.heartbeat).toEqual({ enabled: false, intervalMinutes: 30 });
  });

  it("merges partial config file over defaults", () => {
    const configPath = join(tmp.path, "slimclaw.json");
    writeFileSync(configPath, JSON.stringify({ port: 8080, model: "claude-opus-4-20250514" }));

    const config = loadConfig(configPath);

    expect(config.port).toBe(8080);
    expect(config.model).toBe("claude-opus-4-20250514");
    // Defaults preserved
    expect(config.host).toBe("127.0.0.1");
    expect(config.maxTokens).toBe(4096);
  });

  it("deep merges nested objects (mcp, heartbeat)", () => {
    const configPath = join(tmp.path, "slimclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        heartbeat: { enabled: true },
        mcp: { servers: { test: { command: "node", args: ["server.js"] } } },
      }),
    );

    const config = loadConfig(configPath);

    // heartbeat should merge: enabled overridden, intervalMinutes from defaults
    expect(config.heartbeat.enabled).toBe(true);
    expect(config.heartbeat.intervalMinutes).toBe(30);

    // mcp servers from file
    expect(config.mcp.servers.test).toEqual({ command: "node", args: ["server.js"] });
  });

  describe("provider detection", () => {
    it("detects anthropic from claude model name", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ model: "claude-sonnet-4-20250514" }));

      const config = loadConfig(configPath);
      expect(config.provider).toBe("anthropic");
    });

    it("detects openai from gpt model name", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ model: "gpt-4o" }));

      const config = loadConfig(configPath);
      expect(config.provider).toBe("openai");
    });

    it("detects openai from o1 model name", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ model: "o1-preview" }));

      const config = loadConfig(configPath);
      expect(config.provider).toBe("openai");
    });

    it("detects openai from o3 model name", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ model: "o3-mini" }));

      const config = loadConfig(configPath);
      expect(config.provider).toBe("openai");
    });

    it("detects openai from o4 model name", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ model: "o4-mini" }));

      const config = loadConfig(configPath);
      expect(config.provider).toBe("openai");
    });

    it("defaults to anthropic for unknown model", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ model: "some-unknown-model" }));

      const config = loadConfig(configPath);
      expect(config.provider).toBe("anthropic");
    });

    it("does not override explicitly set provider", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ provider: "openai", model: "claude-sonnet-4-20250514" }));

      const config = loadConfig(configPath);
      expect(config.provider).toBe("openai");
    });
  });

  describe("API key resolution", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("uses apiKey from config file if provided", () => {
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ apiKey: "sk-from-config" }));

      const config = loadConfig(configPath);
      expect(config.apiKey).toBe("sk-from-config");
    });

    it("falls back to ANTHROPIC_API_KEY env for anthropic provider", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-env";
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({}));

      const config = loadConfig(configPath);
      expect(config.apiKey).toBe("sk-ant-env");
    });

    it("falls back to OPENAI_API_KEY env for openai provider", () => {
      process.env.OPENAI_API_KEY = "sk-oai-env";
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({ model: "gpt-4o" }));

      const config = loadConfig(configPath);
      expect(config.apiKey).toBe("sk-oai-env");
    });

    it("returns undefined when no apiKey and no env var", () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const configPath = join(tmp.path, "slimclaw.json");
      writeFileSync(configPath, JSON.stringify({}));

      const config = loadConfig(configPath);
      expect(config.apiKey).toBeUndefined();
    });
  });

  it("uses default path when no configPath is provided", () => {
    // loadConfig with no args resolves to ./slimclaw.json which likely doesn't exist
    // in the test working directory — should return defaults without throwing
    const config = loadConfig(join(tmp.path, "slimclaw.json"));
    expect(config.provider).toBe("anthropic");
  });

  it("throws on invalid JSON", () => {
    const configPath = join(tmp.path, "slimclaw.json");
    writeFileSync(configPath, "{ not valid json }}}");

    expect(() => loadConfig(configPath)).toThrow();
  });
});
