import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers.js";
import { MemoryStore, createMemoryTools } from "../src/memory.js";

describe("MemoryStore", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: Database.Database;
  let memoryDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = tempDir();
    memoryDir = join(tmp.path, "memory");
    mkdirSync(memoryDir, { recursive: true });
    db = new Database(join(tmp.path, "test.db"));
    store = new MemoryStore(db, memoryDir);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  describe("reindex + search", () => {
    it("indexes markdown files and returns search results", () => {
      writeFileSync(
        join(memoryDir, "notes.md"),
        "# TypeScript\nTypeScript is a typed superset of JavaScript.\n",
      );
      store.reindex();

      const results = store.search("TypeScript");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBe("notes.md");
      expect(results[0].content).toContain("TypeScript");
    });

    it("indexes files in subdirectories", () => {
      mkdirSync(join(memoryDir, "sub"), { recursive: true });
      writeFileSync(
        join(memoryDir, "sub", "deep.md"),
        "Deep learning is a subset of machine learning.\n",
      );
      store.reindex();

      const results = store.search("machine learning");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toMatch(/sub\/deep\.md$/);
    });

    it("returns empty results for non-matching query", () => {
      writeFileSync(join(memoryDir, "notes.md"), "Hello world.\n");
      store.reindex();

      const results = store.search("xyznonexistent");
      expect(results).toHaveLength(0);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        writeFileSync(
          join(memoryDir, `note${i}.md`),
          `Testing search result number ${i}.\n`,
        );
      }
      store.reindex();

      const results = store.search("Testing search result", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("handles empty query gracefully", () => {
      writeFileSync(join(memoryDir, "notes.md"), "Some content.\n");
      store.reindex();

      // Should not throw
      const results = store.search("");
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("save", () => {
    it("saves to daily log file by default", () => {
      store.save("Remember this fact.");
      const today = new Date().toISOString().split("T")[0];
      const dailyPath = join(memoryDir, `${today}.md`);
      const content = readFileSync(dailyPath, "utf-8");
      expect(content).toContain("Remember this fact.");
    });

    it("saves to custom path", () => {
      store.save("Custom memory.", "custom/notes.md");
      const content = readFileSync(
        join(memoryDir, "custom", "notes.md"),
        "utf-8",
      );
      expect(content).toContain("Custom memory.");
    });

    it("appends to existing file", () => {
      store.save("First entry.");
      store.save("Second entry.");

      const today = new Date().toISOString().split("T")[0];
      const content = readFileSync(join(memoryDir, `${today}.md`), "utf-8");
      expect(content).toContain("First entry.");
      expect(content).toContain("Second entry.");
    });

    it("reindexes after save so new content is searchable", () => {
      store.save("Quantum computing is fascinating.");

      const results = store.search("Quantum computing");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("Quantum computing");
    });
  });

  describe("getRecentContext", () => {
    it("loads MEMORY.md content", () => {
      writeFileSync(join(memoryDir, "MEMORY.md"), "User prefers dark mode.\n");

      const context = store.getRecentContext();
      expect(context).toContain("User prefers dark mode.");
    });

    it("loads today and yesterday daily logs", () => {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86_400_000)
        .toISOString()
        .split("T")[0];

      writeFileSync(join(memoryDir, `${today}.md`), "Today's notes.\n");
      writeFileSync(
        join(memoryDir, `${yesterday}.md`),
        "Yesterday's notes.\n",
      );

      const context = store.getRecentContext();
      expect(context).toContain("Today's notes.");
      expect(context).toContain("Yesterday's notes.");
      expect(context).toContain(today);
      expect(context).toContain(yesterday);
    });

    it("handles missing files gracefully", () => {
      // No files exist — should return empty string, not throw
      const context = store.getRecentContext();
      expect(context).toBe("");
    });

    it("combines all sources", () => {
      const today = new Date().toISOString().split("T")[0];
      writeFileSync(join(memoryDir, "MEMORY.md"), "Durable fact.\n");
      writeFileSync(join(memoryDir, `${today}.md`), "Today's log.\n");

      const context = store.getRecentContext();
      expect(context).toContain("Durable fact.");
      expect(context).toContain("Today's log.");
    });
  });

  describe("chunk splitting", () => {
    it("keeps short content as a single chunk", () => {
      writeFileSync(join(memoryDir, "short.md"), "Short content.\n");
      store.reindex();

      const results = store.search("Short content");
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("Short content.");
    });

    it("splits long content into multiple chunks", () => {
      // Create content that exceeds 400 tokens (~1600 chars)
      const longContent = Array.from(
        { length: 20 },
        (_, i) => `## Section ${i}\n${"Lorem ipsum dolor sit amet. ".repeat(10)}\n`,
      ).join("\n");

      writeFileSync(join(memoryDir, "long.md"), longContent);
      store.reindex();

      // FTS should have multiple rows for this file
      const count = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM memory_fts WHERE path = 'long.md'",
        )
        .get() as { cnt: number };
      expect(count.cnt).toBeGreaterThan(1);
    });
  });
});

describe("createMemoryTools", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: Database.Database;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = tempDir();
    const memoryDir = join(tmp.path, "memory");
    mkdirSync(memoryDir, { recursive: true });
    db = new Database(join(tmp.path, "test.db"));
    store = new MemoryStore(db, memoryDir);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("returns memory_search and memory_save tools", () => {
    const tools = createMemoryTools(store);
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_save");
  });

  it("memory_save tool saves and memory_search tool finds it", async () => {
    const tools = createMemoryTools(store);
    const saveTool = tools.find((t) => t.definition.name === "memory_save")!;
    const searchTool = tools.find(
      (t) => t.definition.name === "memory_search",
    )!;

    await saveTool.execute({ content: "The capital of France is Paris." });

    const result = await searchTool.execute({ query: "capital France Paris" });
    expect(result).toContain("Paris");
  });

  it("memory_search returns no-match message for empty results", async () => {
    const tools = createMemoryTools(store);
    const searchTool = tools.find(
      (t) => t.definition.name === "memory_search",
    )!;

    const result = await searchTool.execute({ query: "nonexistent query" });
    expect(result).toContain("No matching memories found");
  });
});
