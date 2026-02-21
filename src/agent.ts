import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { SlimClawConfig } from "./config.js";
import type { Session, Message, ContentBlock } from "./session.js";
import { appendMessage } from "./session.js";
import type { Tool } from "./tools.js";
import type { Skill } from "./skills.js";
import { prepareContext } from "./context.js";

// ---------- Types ----------

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; name: string; result: string }
  | { type: "message_stop"; stop_reason: string };

// ---------- LLM Client Interface ----------

export interface LLMClient {
  stream(params: {
    model: string;
    system: string;
    messages: Message[];
    tools: Tool["definition"][];
    max_tokens: number;
  }): AsyncIterable<StreamEvent>;
}

// ---------- Anthropic Client ----------

class AnthropicClient implements LLMClient {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *stream(params: {
    model: string;
    system: string;
    messages: Message[];
    tools: Tool["definition"][];
    max_tokens: number;
  }): AsyncIterable<StreamEvent> {
    const toolDefs = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    }));

    const stream = this.client.messages.stream({
      model: params.model,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      max_tokens: params.max_tokens,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        const delta = event.delta as unknown as Record<string, unknown>;
        if (delta.type === "text_delta") {
          yield { type: "text", text: delta.text as string };
        }
        if (delta.type === "input_json_delta") {
          // Tool input streamed incrementally - we collect in message_stop
        }
      }
    }

    // After stream ends, get the final message
    const finalMessage = await stream.finalMessage();
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        yield {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
    }
    yield { type: "message_stop", stop_reason: finalMessage.stop_reason ?? "end_turn" };
  }
}

// ---------- OpenAI Client ----------

class OpenAIClient implements LLMClient {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({ apiKey });
  }

  async *stream(params: {
    model: string;
    system: string;
    messages: Message[];
    tools: Tool["definition"][];
    max_tokens: number;
  }): AsyncIterable<StreamEvent> {
    // Translate messages from Anthropic format to OpenAI format
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: params.system },
    ];

    for (const msg of params.messages) {
      if (msg.role === "user" && typeof msg.content === "string") {
        openaiMessages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant" && typeof msg.content === "string") {
        openaiMessages.push({ role: "assistant", content: msg.content });
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Assistant message with tool_use blocks
        const textParts = msg.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        const toolCalls = msg.content
          .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));

        openaiMessages.push({
          role: "assistant",
          content: textParts || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        } as OpenAI.ChatCompletionMessageParam);
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        // Tool results
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            openaiMessages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
      }
    }

    const openaiTools: OpenAI.ChatCompletionTool[] = params.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as Record<string, unknown>,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model: params.model,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      max_tokens: params.max_tokens,
      stream: true,
    });

    // Collect tool calls from streamed deltas
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason = "end_turn";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: "text", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCalls.has(tc.index)) {
            toolCalls.set(tc.index, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
          }
          const existing = toolCalls.get(tc.index)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
        }
      }

      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason === "tool_calls") stopReason = "tool_use";
      else if (finishReason === "stop") stopReason = "end_turn";
    }

    // Emit collected tool calls
    for (const [, tc] of toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.args);
      } catch {
        // malformed args
      }
      yield { type: "tool_use", id: tc.id, name: tc.name, input };
    }

    yield { type: "message_stop", stop_reason: stopReason };
  }
}

// ---------- Factory ----------

export function createLLMClient(config: SlimClawConfig): LLMClient {
  if (config.provider === "openai") {
    return new OpenAIClient(config.apiKey);
  }
  return new AnthropicClient(config.apiKey);
}

// ---------- System Prompt Assembly ----------

export function buildSystemPrompt(
  config: SlimClawConfig,
  skills: Skill[],
  memoryContext: string,
): string {
  const parts: string[] = [];

  // Base identity
  parts.push("You are SlimClaw, a personal AI assistant.");

  // Custom system prompt from config
  if (config.systemPrompt) {
    parts.push(config.systemPrompt);
  }

  // Always-on skills (injected into system prompt)
  for (const skill of skills.filter((s) => s.always)) {
    parts.push(`## Skill: ${skill.name}\n${skill.content}`);
  }

  // Available skills list (progressive disclosure - names only)
  const availableSkills = skills.filter((s) => !s.always);
  if (availableSkills.length > 0) {
    parts.push(
      "## Available Skills\n" +
        availableSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n"),
    );
  }

  // Memory context
  if (memoryContext) {
    parts.push(`## Relevant Memories\n${memoryContext}`);
  }

  return parts.join("\n\n");
}

// ---------- Tool Execution ----------

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  tools: Tool[],
): Promise<string> {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) {
    return `Error: Unknown tool "${name}"`;
  }
  try {
    return await tool.execute(input);
  } catch (err) {
    return `Error executing tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------- Core Agent Turn ----------

export async function* agentTurn(
  session: Session,
  userMessage: string,
  config: SlimClawConfig,
  client: LLMClient,
  tools: Tool[],
  skills: Skill[],
  memoryContext: string,
): AsyncGenerator<StreamEvent> {
  // 1. Append user message
  appendMessage(session, { role: "user", content: userMessage });

  // 2. Build system prompt
  const systemPrompt = buildSystemPrompt(config, skills, memoryContext);

  // 3. Agent loop - keep calling LLM until no more tool calls
  while (true) {
    // Collect the streamed response
    const contentBlocks: ContentBlock[] = [];
    let currentText = "";
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let stopReason = "end_turn";

    // Apply context management (history limiting + tool result truncation)
    const contextMessages = prepareContext(session.messages, config);

    const stream = client.stream({
      model: config.model,
      system: systemPrompt,
      messages: contextMessages,
      tools: tools.map((t) => t.definition),
      max_tokens: config.maxTokens,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        currentText += event.text;
        yield event;
      } else if (event.type === "tool_use") {
        toolUses.push(event);
      } else if (event.type === "message_stop") {
        stopReason = event.stop_reason;
      }
    }

    // Build content blocks for the assistant message
    if (currentText) {
      contentBlocks.push({ type: "text", text: currentText });
    }
    for (const tu of toolUses) {
      contentBlocks.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input: tu.input,
      });
    }

    // Append assistant message
    const assistantContent: string | ContentBlock[] =
      contentBlocks.length === 1 && contentBlocks[0].type === "text"
        ? contentBlocks[0].text
        : contentBlocks;
    appendMessage(session, { role: "assistant", content: assistantContent });

    // If no tool use, we're done
    if (toolUses.length === 0) break;

    // Execute each tool call
    const toolResults: ContentBlock[] = [];
    for (const toolUse of toolUses) {
      yield { type: "tool_start", name: toolUse.name, input: toolUse.input };
      const result = await executeTool(toolUse.name, toolUse.input, tools);
      yield { type: "tool_end", name: toolUse.name, result };
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Append tool results and loop
    appendMessage(session, { role: "user", content: toolResults });
  }
}
