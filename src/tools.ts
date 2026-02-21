import { execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "fs";
import { dirname } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Tool {
  definition: {
    name: string;
    description: string;
    input_schema: object;
  };
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Tool result truncation
// ---------------------------------------------------------------------------

const MIN_KEEP_CHARS = 2_000;

export function truncateToolResult(
  text: string,
  maxChars: number,
): string {
  if (text.length <= maxChars) return text;

  const keepChars = Math.max(MIN_KEEP_CHARS, maxChars - 100);
  // Find last newline within 80% of cutpoint (matches OpenClaw heuristic)
  const searchEnd = Math.floor(keepChars * 0.8);
  const lastNewline = text.lastIndexOf("\n", keepChars);
  const cutAt = lastNewline > searchEnd ? lastNewline : keepChars;

  return (
    text.slice(0, cutAt) +
    `\n\n[Truncated: showing first ${cutAt} of ${text.length} characters]`
  );
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === "win32";
const SHELL = IS_WINDOWS ? "cmd.exe" : "/bin/sh";
const SHELL_FLAG = IS_WINDOWS ? "/c" : "-c";

function bashTool(maxResultChars: number): Tool {
  return {
    definition: {
      name: "bash",
      description:
        "Execute a shell command and return stdout + stderr. Use for running scripts, installing packages, or any shell operation.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description:
              "Timeout in milliseconds (default 30 000)",
          },
        },
        required: ["command"],
      },
    },
    async execute(input) {
      const command = input.command as string;
      const timeout = (input.timeout as number) ?? 30_000;

      try {
        const output = execSync(command, {
          timeout,
          encoding: "utf-8",
          shell: SHELL,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          stdio: ["pipe", "pipe", "pipe"],
        });
        return truncateToolResult(output, maxResultChars);
      } catch (err: unknown) {
        const e = err as {
          stdout?: string;
          stderr?: string;
          message?: string;
          status?: number;
        };
        const stdout = e.stdout ?? "";
        const stderr = e.stderr ?? "";
        const combined =
          `Exit code: ${e.status ?? 1}\n` +
          (stdout ? `stdout:\n${stdout}\n` : "") +
          (stderr ? `stderr:\n${stderr}\n` : "") +
          ((!stdout && !stderr) ? `Error: ${e.message}\n` : "");
        return truncateToolResult(combined, maxResultChars);
      }
    },
  };
}

function readFileTool(maxResultChars: number): Tool {
  return {
    definition: {
      name: "read_file",
      description:
        "Read a file and return its contents with line numbers (like cat -n). Supports offset and limit for partial reads.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-based)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read",
          },
        },
        required: ["path"],
      },
    },
    async execute(input) {
      const filePath = input.path as string;
      const offset = (input.offset as number | undefined) ?? 1;
      const limit = input.limit as number | undefined;

      if (!existsSync(filePath)) {
        return `Error: File not found: ${filePath}`;
      }

      const content = readFileSync(filePath, "utf-8");
      let lines = content.split(/\r?\n/);

      // Apply offset (1-based)
      const startIdx = Math.max(0, offset - 1);
      lines = lines.slice(startIdx);

      // Apply limit
      if (limit !== undefined) {
        lines = lines.slice(0, limit);
      }

      // Add line numbers like cat -n
      const numbered = lines.map(
        (line, i) => `${String(startIdx + i + 1).padStart(6, " ")}\t${line}`,
      );

      return truncateToolResult(numbered.join("\n"), maxResultChars);
    },
  };
}

function writeFileTool(): Tool {
  return {
    definition: {
      name: "write_file",
      description:
        "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file",
          },
          content: {
            type: "string",
            description: "Content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
    async execute(input) {
      const filePath = input.path as string;
      const content = input.content as string;

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");

      return `Successfully wrote ${content.length} characters to ${filePath}`;
    },
  };
}

function editFileTool(): Tool {
  return {
    definition: {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file",
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace (must be unique in the file)",
          },
          new_string: {
            type: "string",
            description: "The replacement string",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    async execute(input) {
      const filePath = input.path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;

      if (!existsSync(filePath)) {
        return `Error: File not found: ${filePath}`;
      }

      const content = readFileSync(filePath, "utf-8");

      // Count occurrences
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return `Error: old_string not found in ${filePath}`;
      }
      if (occurrences > 1) {
        return `Error: old_string appears ${occurrences} times in ${filePath} (must be unique)`;
      }

      const updated = content.replace(oldString, newString);
      writeFileSync(filePath, updated, "utf-8");

      return `Successfully edited ${filePath}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBuiltinTools(config: {
  maxToolResultChars: number;
}): Tool[] {
  return [
    bashTool(config.maxToolResultChars),
    readFileTool(config.maxToolResultChars),
    writeFileTool(),
    editFileTool(),
  ];
}
