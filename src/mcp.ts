/**
 * mcp.ts — MCP (Model Context Protocol) server integration.
 *
 * Supports two transport types:
 *   - stdio: Spawns a child-process MCP server (local command)
 *   - url:   Connects to a remote MCP server via Streamable HTTP (or SSE fallback)
 *
 * Discovers tools from each server and converts them into SlimClaw's Tool format
 * so they can be used alongside built-in tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "./tools.js";
import type { SlimClawConfig } from "./config.js";

/** A running MCP server with its discovered tools. */
export interface MCPServer {
  name: string;
  client: Client;
  tools: Tool[];
}

/** Config shape for a single MCP server entry. */
export interface MCPServerConfig {
  /** For stdio transport: the command to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For remote transport: the server URL (e.g. https://example.com/mcp). */
  url?: string;
}

/**
 * Create the appropriate transport based on config.
 * If `url` is present, connect via Streamable HTTP (with SSE fallback).
 * Otherwise, spawn a local process via stdio.
 */
function createTransport(config: MCPServerConfig) {
  if (config.url) {
    const url = new URL(config.url);
    // Use SSE transport for /sse endpoints, Streamable HTTP otherwise
    if (url.pathname.endsWith("/sse")) {
      return new SSEClientTransport(url);
    }
    return new StreamableHTTPClientTransport(url);
  }

  if (!config.command) {
    throw new Error("MCP server config must have either 'url' or 'command'");
  }

  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...config.env } as Record<string, string>,
  });
}

/** Ensure object schemas have a `properties` field (required by OpenAI). */
function normalizeSchema(schema: unknown): Record<string, unknown> {
  const s = (schema ?? { type: "object" }) as Record<string, unknown>;
  if (s.type === "object" && !s.properties) {
    return { ...s, properties: {} };
  }
  return s;
}

/** Convert discovered MCP tools into SlimClaw Tool format. */
function convertTools(name: string, client: Client, mcpTools: Array<{ name: string; description?: string; inputSchema: unknown }>): Tool[] {
  return mcpTools.map((mcpTool) => ({
    definition: {
      name: `mcp_${name}_${mcpTool.name}`,
      description: `[MCP:${name}] ${mcpTool.description ?? ""}`,
      input_schema: normalizeSchema(mcpTool.inputSchema),
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: input,
      });
      // Flatten content array to text
      const content = result.content as Array<{ type: string; text?: string }>;
      return content
        .map((c) => c.text ?? JSON.stringify(c))
        .join("\n");
    },
  }));
}

/**
 * Start a single MCP server, connect via the appropriate transport,
 * discover tools, and convert them to SlimClaw Tool format.
 */
export async function startMCPServer(
  name: string,
  config: MCPServerConfig,
): Promise<MCPServer> {
  const transport = createTransport(config);

  const client = new Client({ name: "slimclaw", version: "1.0.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  const tools = convertTools(name, client, mcpTools);

  const mode = config.url ? `url: ${config.url}` : `command: ${config.command}`;
  console.log(`MCP server "${name}" connected (${mode}), ${tools.length} tools`);

  return { name, client, tools };
}

/**
 * Start all MCP servers defined in config.
 * Failures are logged but don't stop other servers from starting.
 */
export async function startAllMCPServers(
  config: SlimClawConfig,
): Promise<MCPServer[]> {
  const servers: MCPServer[] = [];
  for (const [name, serverConfig] of Object.entries(config.mcp.servers)) {
    try {
      servers.push(await startMCPServer(name, serverConfig));
    } catch (err) {
      console.error(
        `Failed to start MCP server ${name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return servers;
}

/** Stop all running MCP servers. */
export async function stopAllMCPServers(servers: MCPServer[]): Promise<void> {
  for (const server of servers) {
    try {
      await server.client.close();
    } catch {
      // Ignore close errors during shutdown
    }
  }
}
