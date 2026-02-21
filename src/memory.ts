/**
 * memory.ts — Memory storage with FTS5 full-text search.
 *
 * Stores markdown files in a memory directory, indexes them into SQLite FTS5
 * for keyword search, and provides tools for the agent to search and save
 * memories.
 */

import Database from "better-sqlite3";
import { watch } from "chokidar";
import {
  readFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, relative, dirname, sep } from "path";
import type { Tool } from "./tools.js";

export interface MemoryResult {
  path: string;
  content: string;
  rank: number;
}

/**
 * Split text into chunks of roughly `maxTokens` tokens (4 chars ~= 1 token).
 * Splits at paragraph/heading boundaries when possible.
 */
function splitIntoChunks(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  // Split at double newlines (paragraph boundaries) or headings
  const blocks = text.split(/\r?\n(?=\r?\n|#{1,6} )/);

  let current = "";
  for (const block of blocks) {
    if (current.length + block.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += block + "\n";
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Recursively find all markdown files in a directory.
 */
function globMarkdown(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...globMarkdown(fullPath));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

export class MemoryStore {
  private db: Database.Database;
  private memoryDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database.Database, memoryDir: string) {
    this.db = db;
    this.memoryDir = memoryDir;

    // Ensure memory dir exists
    mkdirSync(memoryDir, { recursive: true });

    // Create FTS5 virtual table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
      USING fts5(path, content, chunk_index);
    `);
  }

  /** Index all markdown files in the memory directory. */
  reindex(): void {
    this.db.exec("DELETE FROM memory_fts");

    const insert = this.db.prepare(
      "INSERT INTO memory_fts (path, content, chunk_index) VALUES (?, ?, ?)",
    );

    const insertAll = this.db.transaction(() => {
      for (const file of globMarkdown(this.memoryDir)) {
        const content = readFileSync(file, "utf-8");
        const chunks = splitIntoChunks(content, 400);
        // Normalize to forward slashes for consistent paths across platforms
        const relPath = relative(this.memoryDir, file).split(sep).join("/");
        for (let i = 0; i < chunks.length; i++) {
          insert.run(relPath, chunks[i], i);
        }
      }
    });

    insertAll();
  }

  /** Search memory using FTS5 keyword matching. */
  search(query: string, limit = 10): MemoryResult[] {
    // Tokenize and join with AND for FTS5
    const tokens = query
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .filter((t) => t !== '""');

    const ftsQuery = tokens.length > 0 ? tokens.join(" AND ") : query;

    try {
      return this.db
        .prepare(
          `SELECT path, content, rank FROM memory_fts
           WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, limit) as MemoryResult[];
    } catch {
      // If FTS query syntax fails, return empty results
      return [];
    }
  }

  /** Save content to a memory file. Appends to existing file. */
  save(content: string, path?: string): void {
    const target = path || `${new Date().toISOString().split("T")[0]}.md`;
    const fullPath = join(this.memoryDir, target);
    mkdirSync(dirname(fullPath), { recursive: true });
    appendFileSync(fullPath, `\n${content}\n`, "utf-8");
    this.reindex();
  }

  /** Load recent context for session start (MEMORY.md + today/yesterday). */
  getRecentContext(): string {
    const parts: string[] = [];

    // Load durable memory file
    const memoryFile = join(this.memoryDir, "MEMORY.md");
    if (existsSync(memoryFile)) {
      parts.push(readFileSync(memoryFile, "utf-8"));
    }

    // Load yesterday's and today's daily logs
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .split("T")[0];

    for (const date of [yesterday, today]) {
      const daily = join(this.memoryDir, `${date}.md`);
      if (existsSync(daily)) {
        parts.push(`## ${date}\n${readFileSync(daily, "utf-8")}`);
      }
    }

    return parts.join("\n\n");
  }

  /** Watch memory directory for changes, reindex with debounce. */
  startWatching(): void {
    this.watcher = watch(this.memoryDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });

    const debouncedReindex = () => {
      if (this.reindexTimer) clearTimeout(this.reindexTimer);
      this.reindexTimer = setTimeout(() => this.reindex(), 1500);
    };

    this.watcher.on("add", debouncedReindex);
    this.watcher.on("change", debouncedReindex);
    this.watcher.on("unlink", debouncedReindex);
  }

  /** Stop watching and clean up. */
  stopWatching(): void {
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

/** Create memory_search and memory_save tools for the agent. */
export function createMemoryTools(store: MemoryStore): Tool[] {
  return [
    {
      definition: {
        name: "memory_search",
        description:
          "Search your memory for relevant information using keywords.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query (keywords)",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default 10)",
            },
          },
          required: ["query"],
        },
      },
      async execute(input: Record<string, unknown>): Promise<string> {
        const query = input.query as string;
        const limit = (input.limit as number) ?? 10;
        const results = store.search(query, limit);

        if (results.length === 0) {
          return "No matching memories found.";
        }

        return results
          .map(
            (r, i) =>
              `[${i + 1}] ${r.path}\n${r.content}`,
          )
          .join("\n\n---\n\n");
      },
    },
    {
      definition: {
        name: "memory_save",
        description:
          "Save information to memory for future reference. Content is appended to a daily log or specified file.",
        input_schema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The content to save to memory",
            },
            path: {
              type: "string",
              description:
                "Optional file path within memory directory (defaults to today's daily log)",
            },
          },
          required: ["content"],
        },
      },
      async execute(input: Record<string, unknown>): Promise<string> {
        const content = input.content as string;
        const path = input.path as string | undefined;
        store.save(content, path);
        return `Memory saved${path ? ` to ${path}` : " to daily log"}.`;
      },
    },
  ];
}
