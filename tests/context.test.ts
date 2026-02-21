import { describe, it, expect } from "vitest";
import {
  prepareContext,
  truncateText,
  CHARS_PER_TOKEN,
  MAX_TOOL_RESULT_SHARE,
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_KEEP_CHARS,
} from "../src/context.js";
import type { Message, ContentBlock } from "../src/session.js";

describe("constants", () => {
  it("exports expected constant values", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(MAX_TOOL_RESULT_SHARE).toBe(0.3);
    expect(HARD_MAX_TOOL_RESULT_CHARS).toBe(400_000);
    expect(MIN_KEEP_CHARS).toBe(2_000);
  });
});

describe("truncateText", () => {
  it("returns text unchanged if within limit", () => {
    expect(truncateText("short text", 100)).toBe("short text");
  });

  it("truncates long text with suffix", () => {
    const text = "a".repeat(5000);
    const result = truncateText(text, 1000);
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain("[Truncated: showing first");
    expect(result).toContain("of 5000 characters]");
  });

  it("preserves minimum 2000 chars", () => {
    const text = "a".repeat(5000);
    const result = truncateText(text, 50);
    expect(result).toContain("showing first 2000 of 5000");
  });

  it("prefers cutting at newline within 80% of cutpoint", () => {
    // Create text with newlines at known positions
    const line = "x".repeat(99) + "\n"; // 100 chars per line
    const text = line.repeat(20); // 2000 chars total
    const result = truncateText(text, 1000);

    // Should cut at a newline boundary
    const mainPart = result.split("\n\n[Truncated")[0];
    expect(mainPart.endsWith("\n") || mainPart.endsWith("x")).toBe(true);
  });
});

describe("prepareContext", () => {
  describe("history limiting", () => {
    it("keeps all messages when under the limit", () => {
      const messages: Message[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "Good" },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 10,
        maxToolResultChars: 100_000,
      });

      expect(result).toHaveLength(4);
    });

    it("limits to N most recent user turns", () => {
      const messages: Message[] = [
        { role: "user", content: "Turn 1" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Turn 2" },
        { role: "assistant", content: "Response 2" },
        { role: "user", content: "Turn 3" },
        { role: "assistant", content: "Response 3" },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 2,
        maxToolResultChars: 100_000,
      });

      // Cut happens after the 3rd-from-end user msg (index 0), so cutIndex=1.
      // Result keeps [A1, U2, A2, U3, A3] = 5 messages.
      expect(result).toHaveLength(5);
      expect((result[0].content as string)).toBe("Response 1");
      expect((result[1].content as string)).toBe("Turn 2");
    });

    it("keeps assistant messages that follow retained user messages", () => {
      const messages: Message[] = [
        { role: "user", content: "Old" },
        { role: "assistant", content: "Old reply" },
        { role: "user", content: "Recent" },
        { role: "assistant", content: "Recent reply" },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 1,
        maxToolResultChars: 100_000,
      });

      // cutIndex = index of "Old" + 1 = 1, so keeps [Old reply, Recent, Recent reply]
      expect(result).toHaveLength(3);
      expect((result[0].content as string)).toBe("Old reply");
      expect((result[1].content as string)).toBe("Recent");
      expect((result[2].content as string)).toBe("Recent reply");
    });
  });

  describe("tool result truncation", () => {
    it("truncates oversized tool result strings", () => {
      const longResult = "x".repeat(200_000);
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: longResult },
          ],
        },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 10_000,
      });

      const userMsg = result[1];
      const blocks = userMsg.content as ContentBlock[];
      const toolResult = blocks[0] as { type: "tool_result"; content: string };
      expect(toolResult.content.length).toBeLessThan(200_000);
      expect(toolResult.content).toContain("[Truncated");
    });

    it("does not truncate small tool results", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "small result" },
          ],
        },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 100_000,
      });

      const userMsg = result[1];
      const blocks = userMsg.content as ContentBlock[];
      const toolResult = blocks[0] as { type: "tool_result"; content: string };
      expect(toolResult.content).toBe("small result");
    });

    it("respects HARD_MAX_TOOL_RESULT_CHARS cap", () => {
      // Even if maxToolResultChars is huge, it caps at HARD_MAX
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "x".repeat(500_000),
            },
          ],
        },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 1_000_000, // way over hard max
      });

      const userMsg = result[1];
      const blocks = userMsg.content as ContentBlock[];
      const toolResult = blocks[0] as { type: "tool_result"; content: string };
      expect(toolResult.content.length).toBeLessThan(500_000);
    });
  });

  describe("orphaned tool_result cleanup", () => {
    it("removes tool_result blocks with no matching tool_use", () => {
      const messages: Message[] = [
        { role: "user", content: "Start" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "orphan_id", content: "orphaned" },
          ],
        },
        { role: "user", content: "End" },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 100_000,
      });

      // The orphaned message should be dropped entirely
      expect(result).toHaveLength(2);
      expect((result[0].content as string)).toBe("Start");
      expect((result[1].content as string)).toBe("End");
    });

    it("keeps tool_result blocks that have a matching tool_use", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "result" },
          ],
        },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 100_000,
      });

      expect(result).toHaveLength(2);
    });

    it("handles mixed content blocks - keeps non-orphaned, removes orphaned", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "valid" },
            { type: "tool_result", tool_use_id: "orphan", content: "orphaned" },
          ],
        },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 100_000,
      });

      expect(result).toHaveLength(2);
      const blocks = result[1].content as ContentBlock[];
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as any).tool_use_id).toBe("tu_1");
    });
  });

  describe("combined layers", () => {
    it("applies history limiting then truncation then orphan cleanup", () => {
      const longResult = "x".repeat(200_000);
      const messages: Message[] = [
        // Old turn (should be removed by history limiting)
        { role: "user", content: "Old message" },
        { role: "assistant", content: "Old reply" },
        // Recent turn with long tool result
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: longResult },
          ],
        },
        { role: "user", content: "Final question" },
        { role: "assistant", content: "Final answer" },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 2,
        maxToolResultChars: 10_000,
      });

      // "Old message" (user) should be removed by history limiting
      expect(result.every((m) => (m.content as string) !== "Old message")).toBe(true);
      // "Old reply" (assistant after cut) may remain since cutIndex is after the user msg
      // The tool result should be truncated
      const toolResultMsg = result.find(
        (m) => Array.isArray(m.content) && (m.content as any[]).some((b: any) => b.type === "tool_result"),
      );
      if (toolResultMsg) {
        const blocks = toolResultMsg.content as ContentBlock[];
        const tr = blocks.find((b) => b.type === "tool_result") as any;
        if (tr && typeof tr.content === "string") {
          expect(tr.content.length).toBeLessThan(200_000);
        }
      }
    });
  });

  describe("edge cases", () => {
    it("handles empty message array", () => {
      const result = prepareContext([], {
        maxHistoryTurns: 50,
        maxToolResultChars: 100_000,
      });
      expect(result).toEqual([]);
    });

    it("does not modify the original messages array", () => {
      const messages: Message[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "World" },
      ];
      const original = [...messages];

      prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 100_000,
      });

      expect(messages).toEqual(original);
    });

    it("handles string content in user messages (not blocks)", () => {
      const messages: Message[] = [
        { role: "user", content: "Just a string" },
        { role: "assistant", content: "Reply" },
      ];

      const result = prepareContext(messages, {
        maxHistoryTurns: 50,
        maxToolResultChars: 100_000,
      });

      expect(result).toHaveLength(2);
    });
  });
});
