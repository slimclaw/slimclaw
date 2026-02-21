import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { testConfig } from "./helpers.js";

// Mock homedir BEFORE importing session/agent modules so SESSIONS_DIR
// points to a temp directory instead of the real ~/.slimclaw/sessions.
const TEST_HOME = mkdtempSync(join(tmpdir(), "slimclaw-agent-test-"));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

const {
  agentTurn,
  buildSystemPrompt,
  createLLMClient,
} = await import("../src/agent.js");
type LLMClient = import("../src/agent.js").LLMClient;
type StreamEvent = import("../src/agent.js").StreamEvent;
type Tool = import("../src/agent.js").Tool;
type Skill = import("../src/agent.js").Skill;

const { createSession } = await import("../src/session.js");
type Session = import("../src/session.js").Session;

import { afterAll } from "vitest";

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true });
});

// ---- Helpers ----

/** Collect all events from an agentTurn async generator. */
async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** Create a mock LLM client that returns canned responses in sequence. */
function mockLLMClient(
  responses: Array<{
    text?: string;
    toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stop_reason?: string;
  }>,
): LLMClient {
  let callIndex = 0;
  return {
    async *stream(_params) {
      const response = responses[callIndex++];
      if (!response) {
        throw new Error("No more mock responses available");
      }
      if (response.text) {
        yield { type: "text", text: response.text };
      }
      if (response.toolUses) {
        for (const tu of response.toolUses) {
          yield { type: "tool_use", id: tu.id, name: tu.name, input: tu.input };
        }
      }
      yield {
        type: "message_stop",
        stop_reason: response.stop_reason ?? (response.toolUses ? "tool_use" : "end_turn"),
      };
    },
  };
}

/** Create a simple test tool. */
function createTestTool(name: string, handler: (input: Record<string, unknown>) => string): Tool {
  return {
    definition: {
      name,
      description: `Test tool: ${name}`,
      input_schema: { type: "object", properties: {} },
    },
    execute: async (input) => handler(input),
  };
}

let session: Session;

beforeEach(() => {
  session = createSession(`test-${Date.now()}`);
});

// ---- Tests ----

describe("buildSystemPrompt", () => {
  it("includes base identity", () => {
    const config = testConfig();
    const prompt = buildSystemPrompt(config, [], "");
    expect(prompt).toContain("You are SlimClaw, a personal AI assistant.");
  });

  it("includes custom system prompt from config", () => {
    const config = testConfig({ systemPrompt: "You are a coding assistant." });
    const prompt = buildSystemPrompt(config, [], "");
    expect(prompt).toContain("You are a coding assistant.");
  });

  it("includes always-on skills in system prompt", () => {
    const skills: Skill[] = [
      { name: "math", description: "Math helper", content: "Do math things", always: true },
      { name: "code", description: "Code helper", content: "Do code things", always: false },
    ];
    const prompt = buildSystemPrompt(testConfig(), skills, "");
    expect(prompt).toContain("## Skill: math");
    expect(prompt).toContain("Do math things");
    expect(prompt).not.toContain("## Skill: code");
  });

  it("lists available (non-always) skills by name and description", () => {
    const skills: Skill[] = [
      { name: "weather", description: "Check weather", content: "...", always: false },
      { name: "search", description: "Web search", content: "...", always: false },
    ];
    const prompt = buildSystemPrompt(testConfig(), skills, "");
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("- weather: Check weather");
    expect(prompt).toContain("- search: Web search");
  });

  it("includes memory context when provided", () => {
    const prompt = buildSystemPrompt(testConfig(), [], "User prefers dark mode.");
    expect(prompt).toContain("## Relevant Memories");
    expect(prompt).toContain("User prefers dark mode.");
  });

  it("omits memory section when context is empty", () => {
    const prompt = buildSystemPrompt(testConfig(), [], "");
    expect(prompt).not.toContain("## Relevant Memories");
  });
});

describe("agentTurn", () => {
  it("handles a text-only response (no tools)", async () => {
    const client = mockLLMClient([
      { text: "Hello! How can I help?" },
    ]);

    const events = await collectEvents(
      agentTurn(session, "Hi there", testConfig(), client, [], [], ""),
    );

    // Should have a text event and message_stop
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as { type: "text"; text: string }).text).toBe(
      "Hello! How can I help?",
    );

    // Session should have user + assistant messages
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].content).toBe("Hi there");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[1].content).toBe("Hello! How can I help?");
  });

  it("handles a single tool call + result loop", async () => {
    const echoTool = createTestTool("echo", (input) => `Echo: ${input.msg}`);

    const client = mockLLMClient([
      // First response: tool call
      {
        text: "Let me echo that.",
        toolUses: [{ id: "tu1", name: "echo", input: { msg: "hello" } }],
      },
      // Second response after tool result: final text
      { text: "Done echoing." },
    ]);

    const events = await collectEvents(
      agentTurn(session, "Echo hello", testConfig(), client, [echoTool], [], ""),
    );

    // Should see: text, tool_start, tool_end, text
    const toolStartEvents = events.filter((e) => e.type === "tool_start");
    const toolEndEvents = events.filter((e) => e.type === "tool_end");
    expect(toolStartEvents).toHaveLength(1);
    expect(toolEndEvents).toHaveLength(1);
    expect((toolEndEvents[0] as { type: "tool_end"; result: string }).result).toBe(
      "Echo: hello",
    );

    // Session: user, assistant (with tool_use), user (tool_result), assistant (final)
    expect(session.messages).toHaveLength(4);
    expect(session.messages[2].role).toBe("user"); // tool results
    expect(session.messages[3].content).toBe("Done echoing.");
  });

  it("handles multiple parallel tool calls in one turn", async () => {
    const addTool = createTestTool("add", (input) =>
      String(Number(input.a) + Number(input.b)),
    );
    const mulTool = createTestTool("mul", (input) =>
      String(Number(input.a) * Number(input.b)),
    );

    const client = mockLLMClient([
      {
        toolUses: [
          { id: "tu1", name: "add", input: { a: 2, b: 3 } },
          { id: "tu2", name: "mul", input: { a: 4, b: 5 } },
        ],
      },
      { text: "2+3=5, 4*5=20" },
    ]);

    const events = await collectEvents(
      agentTurn(session, "compute", testConfig(), client, [addTool, mulTool], [], ""),
    );

    const toolEndEvents = events.filter((e) => e.type === "tool_end");
    expect(toolEndEvents).toHaveLength(2);
    expect((toolEndEvents[0] as { type: "tool_end"; result: string }).result).toBe("5");
    expect((toolEndEvents[1] as { type: "tool_end"; result: string }).result).toBe("20");
  });

  it("stops looping when no tool_use is returned", async () => {
    const client = mockLLMClient([{ text: "Just text." }]);

    const events = await collectEvents(
      agentTurn(session, "hello", testConfig(), client, [], [], ""),
    );

    // Only 1 LLM call
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
  });

  it("returns error string for unknown tool", async () => {
    const client = mockLLMClient([
      {
        toolUses: [{ id: "tu1", name: "nonexistent", input: {} }],
      },
      { text: "OK" },
    ]);

    const events = await collectEvents(
      agentTurn(session, "use unknown tool", testConfig(), client, [], [], ""),
    );

    const toolEndEvents = events.filter((e) => e.type === "tool_end");
    expect(toolEndEvents).toHaveLength(1);
    expect((toolEndEvents[0] as { type: "tool_end"; result: string }).result).toContain(
      'Unknown tool "nonexistent"',
    );
  });

  it("handles tool execution errors gracefully", async () => {
    const failTool: Tool = {
      definition: {
        name: "fail",
        description: "Always fails",
        input_schema: { type: "object" },
      },
      execute: async () => {
        throw new Error("Something broke");
      },
    };

    const client = mockLLMClient([
      { toolUses: [{ id: "tu1", name: "fail", input: {} }] },
      { text: "handled" },
    ]);

    const events = await collectEvents(
      agentTurn(session, "do fail", testConfig(), client, [failTool], [], ""),
    );

    const toolEndEvents = events.filter((e) => e.type === "tool_end");
    expect((toolEndEvents[0] as { type: "tool_end"; result: string }).result).toContain(
      "Something broke",
    );
  });

  it("passes tool definitions to LLM client", async () => {
    const streamSpy = vi.fn();
    const spyClient: LLMClient = {
      async *stream(params) {
        streamSpy(params);
        yield { type: "text", text: "ok" };
        yield { type: "message_stop", stop_reason: "end_turn" };
      },
    };

    const tool = createTestTool("test_tool", () => "result");

    await collectEvents(
      agentTurn(session, "hi", testConfig(), spyClient, [tool], [], ""),
    );

    expect(streamSpy).toHaveBeenCalledOnce();
    const params = streamSpy.mock.calls[0][0];
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe("test_tool");
  });
});

describe("createLLMClient", () => {
  it("creates a client based on provider config", () => {
    // Just verify it doesn't throw - we can't test the actual API calls
    const anthropicClient = createLLMClient(testConfig({ provider: "anthropic" }));
    expect(anthropicClient).toBeDefined();
    expect(anthropicClient.stream).toBeTypeOf("function");

    const openaiClient = createLLMClient(testConfig({ provider: "openai", apiKey: "test-key" }));
    expect(openaiClient).toBeDefined();
    expect(openaiClient.stream).toBeTypeOf("function");
  });
});
