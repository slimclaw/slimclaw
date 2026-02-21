import type { SlimClawConfig } from "./config.js";
import type { Tool } from "./tools.js";
import type { LLMClient } from "./agent.js";
import { agentTurn } from "./agent.js";
import { createSession } from "./session.js";

const MAX_DEPTH = 3;

export interface SubAgentConfig {
  name: string;
  systemPrompt: string;
  task: string;
}

/**
 * Spawn an isolated sub-agent with its own session and custom system prompt.
 * Runs the full agent turn loop and returns the collected text output.
 * Sub-agents cannot spawn further sub-agents (spawn_agent tool is excluded).
 */
export async function spawnSubAgent(
  parentConfig: SlimClawConfig,
  subConfig: SubAgentConfig,
  client: LLMClient,
  tools: Tool[],
  depth = 1,
): Promise<string> {
  if (depth > MAX_DEPTH) {
    return `Error: Maximum sub-agent nesting depth (${MAX_DEPTH}) reached.`;
  }

  // Create isolated session
  const session = createSession(`subagent-${subConfig.name}-${Date.now()}`);

  // Override system prompt
  const agentConfig: SlimClawConfig = {
    ...parentConfig,
    systemPrompt: subConfig.systemPrompt,
  };

  // Exclude spawn_agent from sub-agent tools to prevent unbounded recursion
  const subTools = tools.filter((t) => t.definition.name !== "spawn_agent");

  // Run the agent turn (non-streaming, collect full result)
  let result = "";
  for await (const event of agentTurn(session, subConfig.task, agentConfig, client, subTools, [], "")) {
    if (event.type === "text") result += event.text;
  }

  return result;
}

/**
 * Create a spawn_agent tool that the main agent can use to delegate tasks.
 */
export function createSubAgentTool(
  config: SlimClawConfig,
  client: LLMClient,
  tools: Tool[],
): Tool {
  return {
    definition: {
      name: "spawn_agent",
      description: "Spawn a sub-agent with a specific task and system prompt. Sub-agents cannot spawn further sub-agents.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the sub-agent" },
          task: { type: "string", description: "The task to accomplish" },
          system_prompt: { type: "string", description: "System prompt for the sub-agent" },
        },
        required: ["name", "task"],
      },
    },
    execute: async (input) => {
      const name = input.name as string;
      const task = input.task as string;
      const systemPrompt = (input.system_prompt as string) ?? "";
      return spawnSubAgent(config, { name, systemPrompt, task }, client, tools);
    },
  };
}
