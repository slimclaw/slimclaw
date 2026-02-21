// ---------------------------------------------------------------------------
// Context management: history limiting + tool result truncation
// Implements layers 1 and 2 of OpenClaw's 5-layer context management.
// ---------------------------------------------------------------------------

import type { Message, ContentBlock } from "./session.js";

// ---------------------------------------------------------------------------
// Constants (copied from OpenClaw)
// ---------------------------------------------------------------------------

export const CHARS_PER_TOKEN = 4;
export const MAX_TOOL_RESULT_SHARE = 0.3;
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
export const MIN_KEEP_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const keepChars = Math.max(MIN_KEEP_CHARS, maxChars - 100);
  // Find last newline within 80% of cutpoint (copied from OpenClaw)
  const searchEnd = Math.floor(keepChars * 0.8);
  const lastNewline = text.lastIndexOf("\n", keepChars);
  const cutAt = lastNewline > searchEnd ? lastNewline : keepChars;

  return (
    text.slice(0, cutAt) +
    `\n\n[Truncated: showing first ${cutAt} of ${text.length} characters]`
  );
}

// ---------------------------------------------------------------------------
// Layer 1: Limit history turns
// ---------------------------------------------------------------------------

function limitHistoryTurns(messages: Message[], maxTurns: number): Message[] {
  if (maxTurns <= 0) return messages;

  // Count user messages from the end to find the cutoff point.
  // A "turn" is one user message + subsequent assistant messages.
  let userCount = 0;
  let cutIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > maxTurns) {
        cutIndex = i + 1;
        break;
      }
    }
  }

  return messages.slice(cutIndex);
}

// ---------------------------------------------------------------------------
// Layer 2: Truncate oversized tool results
// ---------------------------------------------------------------------------

function truncateToolResults(
  messages: Message[],
  maxChars: number,
): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") {
      return msg;
    }

    const blocks = msg.content;
    const hasToolResult = blocks.some((b) => b.type === "tool_result");
    if (!hasToolResult) return msg;

    const newBlocks = blocks.map((block): ContentBlock => {
      if (block.type !== "tool_result") return block;

      const content = block.content;
      if (typeof content === "string" && content.length > maxChars) {
        return { ...block, content: truncateText(content, maxChars) };
      }

      return block;
    });

    return { ...msg, content: newBlocks };
  });
}

// ---------------------------------------------------------------------------
// Cleanup: Remove orphaned tool_result blocks
// ---------------------------------------------------------------------------

function removeOrphanedToolResults(messages: Message[]): Message[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolUseIds.add(block.id);
        }
      }
    }
  }

  // Filter out orphaned tool_result blocks
  return messages
    .map((msg) => {
      if (msg.role !== "user" || typeof msg.content === "string") {
        return msg;
      }

      const filtered = msg.content.filter((block) => {
        if (block.type !== "tool_result") return true;
        return toolUseIds.has(block.tool_use_id);
      });

      // If all blocks were removed, drop the message entirely
      if (filtered.length === 0) return null;

      return { ...msg, content: filtered };
    })
    .filter((msg): msg is Message => msg !== null);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function prepareContext(
  messages: Message[],
  config: { maxHistoryTurns: number; maxToolResultChars: number },
): Message[] {
  let result = [...messages];

  // Layer 1: Limit history turns
  result = limitHistoryTurns(result, config.maxHistoryTurns);

  // Layer 2: Truncate oversized tool results
  const maxResultChars = Math.min(
    config.maxToolResultChars,
    HARD_MAX_TOOL_RESULT_CHARS,
  );
  result = truncateToolResults(result, maxResultChars);

  // Cleanup: Remove orphaned tool_result blocks
  result = removeOrphanedToolResults(result);

  return result;
}
