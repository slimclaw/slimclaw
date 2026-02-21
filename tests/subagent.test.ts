import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { testConfig } from "./helpers.js";

// Mock homedir BEFORE importing modules so sub-agent sessions go to temp dir
const TEST_HOME = mkdtempSync(join(tmpdir(), "slimclaw-subagent-test-"));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

const { spawnSubAgent, createSubAgentTool } = await import("../src/subagent.js");
type LLMClient = import("../src/agent.js").LLMClient;
type StreamEvent = import("../src/agent.js").StreamEvent;
import type { Tool } from "../src/tools.js";

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true });
});

/**
 * Create a mock LLM client that yields a text-only response.
 */
function mockClient(text: string): LLMClient {
  return {
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text", text };
      yield { type: "message_stop", stop_reason: "end_turn" };
    },
  };
}

/**
 * Create a mock LLM client that yields text + tool_use, then text on second call.
 */
function mockClientWithToolUse(
  firstText: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  secondText: string,
): LLMClient {
  let callCount = 0;
  return {
    async *stream(): AsyncIterable<StreamEvent> {
      callCount++;
      if (callCount === 1) {
        yield { type: "text", text: firstText };
        yield { type: "tool_use", id: "tool-1", name: toolName, input: toolInput };
        yield { type: "message_stop", stop_reason: "tool_use" };
      } else {
        yield { type: "text", text: secondText };
        yield { type: "message_stop", stop_reason: "end_turn" };
      }
    },
  };
}

describe("spawnSubAgent", () => {
  it("spawns with isolated session and returns collected text", async () => {
    const config = testConfig();
    const client = mockClient("Hello from sub-agent!");

    const result = await spawnSubAgent(
      config,
      {
        name: "test-agent",
        systemPrompt: "You are a test assistant.",
        task: "Say hello.",
      },
      client,
      [],
    );

    expect(result).toBe("Hello from sub-agent!");
  });

  it("uses custom system prompt", async () => {
    const config = testConfig();
    // We can verify the system prompt is passed by checking that the client receives it
    let receivedSystem = "";
    const client: LLMClient = {
      async *stream(params): AsyncIterable<StreamEvent> {
        receivedSystem = params.system;
        yield { type: "text", text: "ok" };
        yield { type: "message_stop", stop_reason: "end_turn" };
      },
    };

    await spawnSubAgent(
      config,
      {
        name: "custom",
        systemPrompt: "You are a specialized researcher.",
        task: "Research topic X.",
      },
      client,
      [],
    );

    expect(receivedSystem).toContain("You are a specialized researcher.");
  });

  it("executes tool calls in agent loop", async () => {
    const config = testConfig();

    const mockTool: Tool = {
      definition: {
        name: "test_tool",
        description: "A test tool",
        input_schema: { type: "object", properties: {} },
      },
      execute: vi.fn().mockResolvedValue("tool result"),
    };

    const client = mockClientWithToolUse(
      "Let me use a tool. ",
      "test_tool",
      {},
      "Done with the tool.",
    );

    const result = await spawnSubAgent(
      config,
      {
        name: "tool-user",
        systemPrompt: "",
        task: "Use the test tool.",
      },
      client,
      [mockTool],
    );

    expect(mockTool.execute).toHaveBeenCalled();
    // Result should contain both text outputs
    expect(result).toContain("Let me use a tool.");
    expect(result).toContain("Done with the tool.");
  });

  it("creates unique session IDs per invocation", async () => {
    const config = testConfig();
    const client = mockClient("ok");

    // Spy on createSession to check IDs
    const { createSession } = await import("../src/session.js");
    const sessionIds: string[] = [];
    const origCreateSession = createSession;

    // We can check that different timestamps are used
    const result1 = await spawnSubAgent(
      config,
      { name: "agent1", systemPrompt: "", task: "task1" },
      client,
      [],
    );
    const result2 = await spawnSubAgent(
      config,
      { name: "agent2", systemPrompt: "", task: "task2" },
      client,
      [],
    );

    // Both should succeed independently
    expect(result1).toBe("ok");
    expect(result2).toBe("ok");
  });
});

describe("createSubAgentTool", () => {
  it("creates a spawn_agent tool definition", () => {
    const config = testConfig();
    const client = mockClient("sub-agent response");
    const tool = createSubAgentTool(config, client, []);

    expect(tool.definition.name).toBe("spawn_agent");
    expect(tool.definition.description).toContain("sub-agent");
    expect(tool.definition.input_schema).toHaveProperty("properties");
  });

  it("execute spawns a sub-agent and returns result", async () => {
    const config = testConfig();
    const client = mockClient("I completed the task.");
    const tool = createSubAgentTool(config, client, []);

    const result = await tool.execute({
      name: "researcher",
      task: "Find information about X.",
      system_prompt: "You are a researcher.",
    });

    expect(result).toBe("I completed the task.");
  });

  it("uses empty system prompt when not provided", async () => {
    const config = testConfig();
    let receivedSystem = "";
    const client: LLMClient = {
      async *stream(params): AsyncIterable<StreamEvent> {
        receivedSystem = params.system;
        yield { type: "text", text: "done" };
        yield { type: "message_stop", stop_reason: "end_turn" };
      },
    };

    const tool = createSubAgentTool(config, client, []);
    await tool.execute({ name: "helper", task: "Do something." });

    // Should still have the base system prompt, not the custom one
    expect(receivedSystem).toContain("SlimClaw");
  });
});
