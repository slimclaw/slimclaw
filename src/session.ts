import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { homedir } from "os";

// ---------- Types (Anthropic-native message format) ----------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export interface Session {
  id: string;
  messages: Message[];
  filePath: string;
}

// ---------- JSONL entry types ----------

interface SessionEntry {
  type: "session";
  id: string;
  createdAt: number;
}

interface MessageEntry {
  type: "message";
  role: "user" | "assistant";
  content: string | ContentBlock[];
  timestamp: number;
}

type JournalEntry = SessionEntry | MessageEntry;

// ---------- Sessions directory ----------

const SESSIONS_DIR = join(homedir(), ".slimclaw", "sessions");

function ensureSessionsDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionFilePath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

// ---------- Core operations ----------

/** Create a new session with an optional ID. */
export function createSession(id?: string): Session {
  ensureSessionsDir();
  const sessionId = id ?? randomUUID();
  const filePath = sessionFilePath(sessionId);

  const header: SessionEntry = {
    type: "session",
    id: sessionId,
    createdAt: Date.now(),
  };
  writeFileSync(filePath, JSON.stringify(header) + "\n", "utf-8");

  return { id: sessionId, messages: [], filePath };
}

/** Load an existing session from its JSONL file. */
export function loadSession(id: string): Session {
  const filePath = sessionFilePath(id);
  if (!existsSync(filePath)) {
    throw new Error(`Session not found: ${id}`);
  }

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.trim().split(/\r?\n/);
  const messages: Message[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as JournalEntry;
      if (entry.type === "message") {
        messages.push({ role: entry.role, content: entry.content });
      }
    } catch {
      // Skip corrupt lines
    }
  }

  return { id, messages, filePath };
}

/** Append a message to the session (in-memory + on disk). */
export function appendMessage(session: Session, message: Message): void {
  session.messages.push(message);

  const entry: MessageEntry = {
    type: "message",
    role: message.role,
    content: message.content,
    timestamp: Date.now(),
  };
  appendFileSync(session.filePath, JSON.stringify(entry) + "\n", "utf-8");
}

/** List all sessions with their last-active timestamp. */
export function listSessions(): { id: string; lastActive: number }[] {
  ensureSessionsDir();
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));

  return files.map((file) => {
    const id = file.replace(/\.jsonl$/, "");
    const filePath = sessionFilePath(id);
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);

    // Last active = timestamp of last message, or session creation time
    let lastActive = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.type === "session") lastActive = entry.createdAt;
        if (entry.type === "message") lastActive = entry.timestamp;
      } catch {
        // skip
      }
    }

    return { id, lastActive };
  }).sort((a, b) => b.lastActive - a.lastActive);
}
