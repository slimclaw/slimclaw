import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { readFileSync, mkdirSync, appendFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

// Create a temp dir BEFORE the module loads so SESSIONS_DIR picks it up.
const TEST_HOME = mkdtempSync(join(tmpdir(), "slimclaw-session-test-"));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

// Dynamic import after mock is set up — SESSIONS_DIR will use TEST_HOME
const { createSession, loadSession, appendMessage, listSessions } = await import(
  "../src/session.js"
);

const SESSIONS_DIR = join(TEST_HOME, ".slimclaw", "sessions");

function cleanSessions(): void {
  // Remove all .jsonl files in the sessions directory
  if (readdirSync(SESSIONS_DIR).length > 0) {
    for (const file of readdirSync(SESSIONS_DIR)) {
      rmSync(join(SESSIONS_DIR, file));
    }
  }
}

describe("session", () => {
  beforeAll(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  });

  beforeEach(() => {
    cleanSessions();
  });

  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true });
  });

  describe("createSession", () => {
    it("creates a session with a random ID when none is provided", () => {
      const session = createSession();
      expect(session.id).toBeTruthy();
      expect(session.messages).toEqual([]);
      expect(session.filePath).toContain(session.id);
    });

    it("creates a session with a given ID", () => {
      const session = createSession("my-session");
      expect(session.id).toBe("my-session");
    });

    it("writes a JSONL header to disk", () => {
      const session = createSession("header-test");
      const raw = readFileSync(session.filePath, "utf-8");
      const header = JSON.parse(raw.trim());
      expect(header.type).toBe("session");
      expect(header.id).toBe("header-test");
      expect(header.createdAt).toBeTypeOf("number");
    });
  });

  describe("loadSession", () => {
    it("loads messages from a JSONL file", () => {
      const session = createSession("load-test");
      appendMessage(session, { role: "user", content: "Hello" });
      appendMessage(session, {
        role: "assistant",
        content: "Hi there!",
      });

      const loaded = loadSession("load-test");
      expect(loaded.id).toBe("load-test");
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[0]).toEqual({ role: "user", content: "Hello" });
      expect(loaded.messages[1]).toEqual({
        role: "assistant",
        content: "Hi there!",
      });
    });

    it("throws when session does not exist", () => {
      expect(() => loadSession("nonexistent")).toThrow("Session not found");
    });

    it("skips corrupt JSONL lines gracefully", () => {
      const session = createSession("corrupt-test");
      appendMessage(session, { role: "user", content: "Good line" });

      // Append a corrupt line directly
      appendFileSync(session.filePath, "{ this is not valid json }\n");
      appendMessage(session, {
        role: "assistant",
        content: "Another good line",
      });

      const loaded = loadSession("corrupt-test");
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[0].content).toBe("Good line");
      expect(loaded.messages[1].content).toBe("Another good line");
    });
  });

  describe("appendMessage", () => {
    it("appends a message to in-memory array and disk", () => {
      const session = createSession("append-test");
      appendMessage(session, { role: "user", content: "First" });

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].content).toBe("First");

      // Verify it was written to disk
      const raw = readFileSync(session.filePath, "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2); // header + message
      const entry = JSON.parse(lines[1]);
      expect(entry.type).toBe("message");
      expect(entry.role).toBe("user");
      expect(entry.content).toBe("First");
      expect(entry.timestamp).toBeTypeOf("number");
    });

    it("handles content blocks (tool_use / tool_result)", () => {
      const session = createSession("blocks-test");

      const toolUseContent = [
        { type: "tool_use" as const, id: "tu_1", name: "bash", input: { command: "ls" } },
      ];
      appendMessage(session, { role: "assistant", content: toolUseContent });

      const toolResultContent = [
        { type: "tool_result" as const, tool_use_id: "tu_1", content: "file1.txt\nfile2.txt" },
      ];
      appendMessage(session, { role: "user", content: toolResultContent });

      const loaded = loadSession("blocks-test");
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[0].content).toEqual(toolUseContent);
      expect(loaded.messages[1].content).toEqual(toolResultContent);
    });
  });

  describe("listSessions", () => {
    it("returns an empty array when no sessions exist", () => {
      const sessions = listSessions();
      expect(sessions).toEqual([]);
    });

    it("returns sessions sorted by last active (most recent first)", () => {
      createSession("old-session");
      const newer = createSession("new-session");
      appendMessage(newer, { role: "user", content: "Recent message" });

      const sessions = listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe("new-session");
      expect(sessions[1].id).toBe("old-session");
    });

    it("includes lastActive timestamp", () => {
      createSession("timestamp-test");
      const sessions = listSessions();
      expect(sessions[0].lastActive).toBeTypeOf("number");
      expect(sessions[0].lastActive).toBeGreaterThan(0);
    });
  });

  describe("roundtrip", () => {
    it("preserves messages through create -> append -> load cycle", () => {
      const session = createSession("roundtrip");
      appendMessage(session, { role: "user", content: "What is 2+2?" });
      appendMessage(session, {
        role: "assistant",
        content: [{ type: "text" as const, text: "4" }],
      });
      appendMessage(session, { role: "user", content: "Thanks" });

      const loaded = loadSession("roundtrip");
      expect(loaded.messages).toHaveLength(3);
      expect(loaded.messages[0]).toEqual({ role: "user", content: "What is 2+2?" });
      expect(loaded.messages[1]).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "4" }],
      });
      expect(loaded.messages[2]).toEqual({ role: "user", content: "Thanks" });
    });
  });
});
