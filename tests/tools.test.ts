import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createBuiltinTools, truncateToolResult } from "../src/tools.js";
import type { Tool } from "../src/tools.js";
import { tempDir } from "./helpers.js";

describe("truncateToolResult", () => {
  it("returns text unchanged if within limit", () => {
    const text = "Hello world";
    expect(truncateToolResult(text, 100)).toBe(text);
  });

  it("truncates long text with suffix", () => {
    const text = "a".repeat(10_000);
    const result = truncateToolResult(text, 5000);
    expect(result.length).toBeLessThan(10_000);
    expect(result).toContain("[Truncated: showing first");
    expect(result).toContain("of 10000 characters]");
  });

  it("prefers cutting at newline boundary within 80% of cutpoint", () => {
    // Build text with a newline at a strategic position
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push("x".repeat(10));
    }
    const text = lines.join("\n"); // ~1099 chars (100 * 10 + 99 newlines)
    const result = truncateToolResult(text, 500);
    // Should cut at a newline, not mid-word
    const beforeTruncMsg = result.split("\n\n[Truncated")[0];
    expect(beforeTruncMsg.endsWith("x")).toBe(true); // cuts at end of a line
  });

  it("preserves minimum 2000 chars even with small maxChars", () => {
    const text = "a".repeat(5000);
    const result = truncateToolResult(text, 100);
    // The keepChars should be max(2000, 100 - 100) = 2000
    expect(result).toContain("[Truncated: showing first 2000 of 5000 characters]");
  });
});

describe("built-in tools", () => {
  let tools: Tool[];
  let tmp: ReturnType<typeof tempDir>;

  beforeEach(() => {
    tmp = tempDir();
    tools = createBuiltinTools({ maxToolResultChars: 100_000 });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  function findTool(name: string): Tool {
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  describe("bash", () => {
    it("captures stdout", async () => {
      const bash = findTool("bash");
      const result = await bash.execute({ command: "echo hello" });
      expect(result.trim()).toBe("hello");
    });

    it("captures stderr on failure", async () => {
      const bash = findTool("bash");
      const result = await bash.execute({
        command: "echo err >&2 && exit 1",
      });
      expect(result).toContain("Exit code: 1");
      expect(result).toContain("err");
    });

    it("handles command timeout", async () => {
      const bash = findTool("bash");
      const result = await bash.execute({
        command: "sleep 10",
        timeout: 100,
      });
      // Should return an error, not hang
      expect(result).toContain("Exit code:");
    });
  });

  describe("read_file", () => {
    it("reads a file with line numbers", async () => {
      const filePath = join(tmp.path, "test.txt");
      writeFileSync(filePath, "line one\nline two\nline three");

      const readFile = findTool("read_file");
      const result = await readFile.execute({ path: filePath });

      expect(result).toContain("1\tline one");
      expect(result).toContain("2\tline two");
      expect(result).toContain("3\tline three");
    });

    it("supports offset and limit", async () => {
      const filePath = join(tmp.path, "offset.txt");
      writeFileSync(filePath, "a\nb\nc\nd\ne");

      const readFile = findTool("read_file");
      const result = await readFile.execute({
        path: filePath,
        offset: 2,
        limit: 2,
      });

      expect(result).toContain("2\tb");
      expect(result).toContain("3\tc");
      expect(result).not.toContain("1\ta");
      expect(result).not.toContain("4\td");
    });

    it("returns error for nonexistent file", async () => {
      const readFile = findTool("read_file");
      const result = await readFile.execute({
        path: join(tmp.path, "nope.txt"),
      });
      expect(result).toContain("Error: File not found");
    });
  });

  describe("write_file", () => {
    it("writes a file and creates directories", async () => {
      const filePath = join(tmp.path, "sub", "dir", "file.txt");

      const writeTool = findTool("write_file");
      const result = await writeTool.execute({
        path: filePath,
        content: "hello world",
      });

      expect(result).toContain("Successfully wrote");
      expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    });

    it("overwrites existing file", async () => {
      const filePath = join(tmp.path, "overwrite.txt");
      writeFileSync(filePath, "old content");

      const writeTool = findTool("write_file");
      await writeTool.execute({ path: filePath, content: "new content" });

      expect(readFileSync(filePath, "utf-8")).toBe("new content");
    });
  });

  describe("edit_file", () => {
    it("replaces a unique string match", async () => {
      const filePath = join(tmp.path, "edit.txt");
      writeFileSync(filePath, "Hello world\nGoodbye world");

      const editTool = findTool("edit_file");
      const result = await editTool.execute({
        path: filePath,
        old_string: "Hello world",
        new_string: "Hi world",
      });

      expect(result).toContain("Successfully edited");
      expect(readFileSync(filePath, "utf-8")).toBe("Hi world\nGoodbye world");
    });

    it("rejects non-unique match", async () => {
      const filePath = join(tmp.path, "dup.txt");
      writeFileSync(filePath, "foo bar\nfoo baz\nfoo qux");

      const editTool = findTool("edit_file");
      const result = await editTool.execute({
        path: filePath,
        old_string: "foo",
        new_string: "replaced",
      });

      expect(result).toContain("appears 3 times");
    });

    it("returns error when old_string not found", async () => {
      const filePath = join(tmp.path, "notfound.txt");
      writeFileSync(filePath, "some content");

      const editTool = findTool("edit_file");
      const result = await editTool.execute({
        path: filePath,
        old_string: "nonexistent",
        new_string: "replacement",
      });

      expect(result).toContain("not found");
    });

    it("returns error for nonexistent file", async () => {
      const editTool = findTool("edit_file");
      const result = await editTool.execute({
        path: join(tmp.path, "missing.txt"),
        old_string: "a",
        new_string: "b",
      });

      expect(result).toContain("Error: File not found");
    });
  });

  describe("tool definitions", () => {
    it("creates exactly 4 tools", () => {
      expect(tools).toHaveLength(4);
    });

    it("each tool has name, description, and input_schema", () => {
      for (const tool of tools) {
        expect(tool.definition.name).toBeTypeOf("string");
        expect(tool.definition.description).toBeTypeOf("string");
        expect(tool.definition.input_schema).toBeTypeOf("object");
      }
    });

    it("includes bash, read_file, write_file, edit_file", () => {
      const names = tools.map((t) => t.definition.name).sort();
      expect(names).toEqual(["bash", "edit_file", "read_file", "write_file"]);
    });
  });
});
