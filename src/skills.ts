import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import { watch } from "chokidar";

import type { Tool } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillTool {
  name: string;
  description: string;
  parameters: { name: string; type: string; required: boolean; description: string }[];
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  always: boolean;
  tools?: SkillTool[];
  requires?: {
    bins?: string[];
    env?: string[];
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseToolSection(markdown: string): SkillTool[] {
  const tools: SkillTool[] = [];
  // Match ### headings under the ## Tools section
  const toolsSection = markdown.match(/## Tools\r?\n([\s\S]*?)(?=\r?\n## |\r?\n---|\s*$)/);
  if (!toolsSection) return tools;

  const body = toolsSection[1];
  // Split on ### headings; the regex captures the heading text after ###
  const toolBlocks = body.split(/\r?\n### /).filter(Boolean);

  for (const block of toolBlocks) {
    const lines = block.trim().split(/\r?\n/);
    // Strip any leftover ### prefix (first block may include it)
    const name = lines[0].replace(/^#+\s*/, "").trim();
    if (!name) continue;

    const description = lines[1]?.trim() ?? "";
    const parameters: SkillTool["parameters"] = [];

    // Parse parameter list: "- paramName (type, required): description"
    for (const line of lines.slice(2)) {
      const match = line.match(
        /^- (\w+)\s*\((\w+)(?:,\s*(required|optional))?\)(?::\s*(.*))?$/,
      );
      if (match) {
        parameters.push({
          name: match[1],
          type: match[2],
          required: match[3] !== "optional",
          description: match[4]?.trim() ?? "",
        });
      }
    }

    tools.push({ name, description, parameters });
  }

  return tools;
}

function parseSkillFile(filePath: string): Skill | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);

    const name = (data.name as string) || basename(filePath, ".md");
    const description = (data.description as string) || "";
    const always = Boolean(data.always);
    const requires = data.requires as Skill["requires"] | undefined;

    const tools = parseToolSection(content);

    return {
      name,
      description,
      content: content.trim(),
      always,
      tools: tools.length > 0 ? tools : undefined,
      requires,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function loadSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return [];

  const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  const skills: Skill[] = [];

  for (const file of files) {
    const skill = parseSkillFile(join(skillsDir, file));
    if (skill) skills.push(skill);
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Hot reload via file watcher
// ---------------------------------------------------------------------------

export function watchSkills(
  skillsDir: string,
  onReload: (skills: Skill[]) => void,
): { close: () => Promise<void> } {
  const watcher = watch(skillsDir, {
    ignoreInitial: true,
    // awaitWriteFinish is intentionally not used — chokidar 4 handles this natively
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const reload = (path: string) => {
    if (!path.endsWith(".md")) return;
    // Debounce to avoid reading partially-written files
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const skills = loadSkills(skillsDir);
      onReload(skills);
    }, 100);
  };

  watcher.on("add", reload);
  watcher.on("change", reload);
  watcher.on("unlink", reload);

  return {
    close: () => watcher.close(),
  };
}

// ---------------------------------------------------------------------------
// Convert skill tools to Tool format for the agent
// ---------------------------------------------------------------------------

export function skillTools(skills: Skill[]): Tool[] {
  const tools: Tool[] = [];

  for (const skill of skills) {
    if (!skill.tools) continue;

    for (const st of skill.tools) {
      const properties: Record<string, object> = {};
      const required: string[] = [];

      for (const param of st.parameters) {
        properties[param.name] = {
          type: param.type,
          description: param.description,
        };
        if (param.required) {
          required.push(param.name);
        }
      }

      tools.push({
        definition: {
          name: st.name,
          description: `[Skill:${skill.name}] ${st.description}`,
          input_schema: {
            type: "object",
            properties,
            required: required.length > 0 ? required : undefined,
          },
        },
        async execute(_input) {
          // Skill tools are placeholders — the actual logic is in the LLM's
          // instructions from the skill content. This returns a note telling
          // the LLM to follow the skill's instructions.
          return `Tool ${st.name} from skill "${skill.name}" invoked. Follow the skill instructions to produce a response.`;
        },
      });
    }
  }

  return tools;
}
