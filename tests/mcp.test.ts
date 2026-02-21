import { describe, it, expect, vi, beforeEach } from "vitest";
import { testConfig } from "./helpers.js";

// Mock the MCP SDK modules before importing the module under test
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const Client = vi.fn().mockImplementation(function (this: any) {
    this.connect = mockConnect;
    this.close = mockClose;
    this.listTools = mockListTools;
    this.callTool = mockCallTool;
  });
  return { Client };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  const StdioClientTransport = vi.fn().mockImplementation(function (this: any, opts: unknown) {
    this._opts = opts;
  });
  return { StdioClientTransport };
});

import {
  startMCPServer,
  startAllMCPServers,
  stopAllMCPServers,
} from "../src/mcp.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startMCPServer", () => {
  it("connects to a server and discovers tools", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          inputSchema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
    });

    const server = await startMCPServer("weather", {
      command: "node",
      args: ["weather-server.js"],
      env: { API_KEY: "test-key" },
    });

    expect(server.name).toBe("weather");
    expect(server.tools).toHaveLength(1);
    expect(server.tools[0].definition.name).toBe("mcp_weather_get_weather");
    expect(server.tools[0].definition.description).toBe(
      "[MCP:weather] Get current weather",
    );
    expect(server.tools[0].definition.input_schema).toEqual({
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    });
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it("prefixes tool names with mcp_{serverName}_{toolName}", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: "search", description: "Search docs", inputSchema: {} },
        { name: "index", description: "Index docs", inputSchema: {} },
      ],
    });

    const server = await startMCPServer("docs", {
      command: "docs-server",
    });

    expect(server.tools.map((t) => t.definition.name)).toEqual([
      "mcp_docs_search",
      "mcp_docs_index",
    ]);
  });

  it("handles tools with no description", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: "ping", description: undefined, inputSchema: {} },
      ],
    });

    const server = await startMCPServer("test", { command: "test-server" });

    expect(server.tools[0].definition.description).toBe("[MCP:test] ");
  });

  it("tool execute calls client.callTool and flattens text content", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: "greet", description: "Say hello", inputSchema: {} },
      ],
    });

    mockCallTool.mockResolvedValue({
      content: [
        { type: "text", text: "Hello, " },
        { type: "text", text: "world!" },
      ],
    });

    const server = await startMCPServer("greeter", { command: "greet-server" });
    const result = await server.tools[0].execute({ name: "Alice" });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: "greet",
      arguments: { name: "Alice" },
    });
    expect(result).toBe("Hello, \nworld!");
  });

  it("tool execute falls back to JSON.stringify for non-text content", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: "data", description: "Get data", inputSchema: {} },
      ],
    });

    mockCallTool.mockResolvedValue({
      content: [
        { type: "image", data: "base64stuff" },
      ],
    });

    const server = await startMCPServer("api", { command: "api-server" });
    const result = await server.tools[0].execute({});

    expect(result).toBe(JSON.stringify({ type: "image", data: "base64stuff" }));
  });

  it("discovers zero tools from a server with none", async () => {
    mockListTools.mockResolvedValue({ tools: [] });

    const server = await startMCPServer("empty", { command: "empty-server" });

    expect(server.tools).toEqual([]);
  });
});

describe("startAllMCPServers", () => {
  it("starts all servers from config", async () => {
    mockListTools.mockResolvedValue({ tools: [] });

    const config = testConfig({
      mcp: {
        servers: {
          alpha: { command: "alpha-server" },
          beta: { command: "beta-server", args: ["--port", "9000"] },
        },
      },
    });

    const servers = await startAllMCPServers(config);

    expect(servers).toHaveLength(2);
    expect(servers[0].name).toBe("alpha");
    expect(servers[1].name).toBe("beta");
  });

  it("returns empty array when no servers configured", async () => {
    const config = testConfig({ mcp: { servers: {} } });
    const servers = await startAllMCPServers(config);

    expect(servers).toEqual([]);
  });

  it("continues starting remaining servers when one fails", async () => {
    let callCount = 0;
    mockConnect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Connection refused");
      }
    });
    mockListTools.mockResolvedValue({ tools: [] });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const config = testConfig({
      mcp: {
        servers: {
          failing: { command: "bad-server" },
          working: { command: "good-server" },
        },
      },
    });

    const servers = await startAllMCPServers(config);

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("working");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to start MCP server failing:",
      "Connection refused",
    );

    consoleSpy.mockRestore();
  });
});

describe("stopAllMCPServers", () => {
  it("closes all server clients", async () => {
    mockListTools.mockResolvedValue({ tools: [] });

    const s1 = await startMCPServer("a", { command: "a" });
    const s2 = await startMCPServer("b", { command: "b" });

    await stopAllMCPServers([s1, s2]);

    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it("handles close errors gracefully", async () => {
    mockListTools.mockResolvedValue({ tools: [] });
    mockClose.mockRejectedValue(new Error("Already closed"));

    const server = await startMCPServer("x", { command: "x" });

    // Should not throw
    await expect(stopAllMCPServers([server])).resolves.toBeUndefined();
  });

  it("handles empty server list", async () => {
    await expect(stopAllMCPServers([])).resolves.toBeUndefined();
  });
});
