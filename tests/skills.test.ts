import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers.js";
import { loadSkills, skillTools, watchSkills } from "../src/skills.js";

describe("skills", () => {
  let cleanup: (() => void) | null = null;
  let dir: string;

  function setup() {
    const tmp = tempDir();
    dir = tmp.path;
    cleanup = tmp.cleanup;
    return dir;
  }

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  function writeSkill(name: string, content: string) {
    writeFileSync(join(dir, `${name}.md`), content, "utf-8");
  }

  // -----------------------------------------------------------------------
  // Basic loading
  // -----------------------------------------------------------------------

  it("parses a valid skill file with all fields", () => {
    setup();
    writeSkill(
      "weather",
      `---
name: weather
description: Check weather for any location
always: false
requires:
  env: [WEATHER_API_KEY]
---

## Instructions
Use the get_weather tool.

## Tools
### get_weather
Get current weather for a location.
Parameters:
- location (string, required): City name or coordinates
`,
    );

    const skills = loadSkills(dir);
    expect(skills).toHaveLength(1);

    const s = skills[0];
    expect(s.name).toBe("weather");
    expect(s.description).toBe("Check weather for any location");
    expect(s.always).toBe(false);
    expect(s.requires?.env).toEqual(["WEATHER_API_KEY"]);
    expect(s.content).toContain("## Instructions");
    expect(s.tools).toHaveLength(1);
    expect(s.tools![0].name).toBe("get_weather");
    expect(s.tools![0].parameters).toHaveLength(1);
    expect(s.tools![0].parameters[0].name).toBe("location");
    expect(s.tools![0].parameters[0].required).toBe(true);
  });

  it("uses defaults for missing frontmatter fields", () => {
    setup();
    writeSkill(
      "simple",
      `---
name: simple
---

Just some instructions.
`,
    );

    const skills = loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("simple");
    expect(skills[0].description).toBe("");
    expect(skills[0].always).toBe(false);
    expect(skills[0].tools).toBeUndefined();
    expect(skills[0].requires).toBeUndefined();
  });

  it("falls back to filename when name is missing from frontmatter", () => {
    setup();
    writeSkill(
      "fallback",
      `---
description: A skill without a name field
---

Content here.
`,
    );

    const skills = loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("fallback");
  });

  // -----------------------------------------------------------------------
  // Multiple skills
  // -----------------------------------------------------------------------

  it("loads multiple skill files from a directory", () => {
    setup();
    writeSkill(
      "alpha",
      `---
name: alpha
description: First skill
always: true
---

Alpha instructions.
`,
    );
    writeSkill(
      "beta",
      `---
name: beta
description: Second skill
---

Beta instructions.
`,
    );

    const skills = loadSkills(dir);
    expect(skills).toHaveLength(2);

    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("returns empty array for non-existent directory", () => {
    const skills = loadSkills("/tmp/definitely-does-not-exist-slimclaw");
    expect(skills).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Tool parsing
  // -----------------------------------------------------------------------

  it("extracts multiple tools from ## Tools section", () => {
    setup();
    writeSkill(
      "multi-tool",
      `---
name: multi-tool
description: Skill with multiple tools
---

## Instructions
Use these tools.

## Tools
### tool_a
First tool.
Parameters:
- x (number, required): A number
- y (string, optional): A string

### tool_b
Second tool.
Parameters:
- query (string, required): Search query
`,
    );

    const skills = loadSkills(dir);
    expect(skills[0].tools).toHaveLength(2);
    expect(skills[0].tools![0].name).toBe("tool_a");
    expect(skills[0].tools![0].parameters).toHaveLength(2);
    expect(skills[0].tools![0].parameters[1].required).toBe(false);
    expect(skills[0].tools![1].name).toBe("tool_b");
  });

  it("parses skill with requires.bins", () => {
    setup();
    writeSkill(
      "cli",
      `---
name: cli
description: CLI skill
requires:
  bins: [gh, jq]
---

Instructions.
`,
    );

    const skills = loadSkills(dir);
    expect(skills[0].requires?.bins).toEqual(["gh", "jq"]);
  });

  // -----------------------------------------------------------------------
  // skillTools conversion
  // -----------------------------------------------------------------------

  it("converts skill tools to Tool format", () => {
    setup();
    writeSkill(
      "calc",
      `---
name: calc
description: Calculator
---

## Tools
### calculate
Evaluate expression.
Parameters:
- expression (string, required): Math expression
`,
    );

    const skills = loadSkills(dir);
    const tools = skillTools(skills);

    expect(tools).toHaveLength(1);
    expect(tools[0].definition.name).toBe("calculate");
    expect(tools[0].definition.description).toContain("[Skill:calc]");
    expect(tools[0].definition.input_schema).toEqual({
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression" },
      },
      required: ["expression"],
    });
  });

  it("returns empty array for skills without tools", () => {
    setup();
    writeSkill(
      "notool",
      `---
name: notool
description: No tools
---

Just instructions.
`,
    );

    const skills = loadSkills(dir);
    const tools = skillTools(skills);
    expect(tools).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Progressive disclosure (always vs on-demand)
  // -----------------------------------------------------------------------

  it("distinguishes always=true from always=false skills", () => {
    setup();
    writeSkill(
      "always-on",
      `---
name: always-on
description: Always active
always: true
---

Always injected.
`,
    );
    writeSkill(
      "on-demand",
      `---
name: on-demand
description: Only when needed
always: false
---

On demand only.
`,
    );

    const skills = loadSkills(dir);
    const alwaysSkills = skills.filter((s) => s.always);
    const onDemand = skills.filter((s) => !s.always);

    expect(alwaysSkills).toHaveLength(1);
    expect(alwaysSkills[0].name).toBe("always-on");
    expect(onDemand).toHaveLength(1);
    expect(onDemand[0].name).toBe("on-demand");
  });

  // -----------------------------------------------------------------------
  // Hot reload
  // -----------------------------------------------------------------------

  it(
    "triggers reload callback on file change",
    async () => {
      setup();
      writeSkill(
        "initial",
        `---
name: initial
description: Initial skill
---

Initial content.
`,
      );

      const reloaded = new Promise<ReturnType<typeof loadSkills>>((resolve) => {
        const watcher = watchSkills(dir, (skills) => {
          // Only resolve when we see the updated content
          const updated = skills.find((s) => s.description === "Updated skill");
          if (updated) {
            watcher.close();
            resolve(skills);
          }
        });
      });

      // Give watcher time to initialize (macOS FSEvents needs extra time in temp dirs)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      writeSkill(
        "initial",
        `---
name: initial
description: Updated skill
---

Updated content.
`,
      );

      const reloadedSkills = await reloaded;

      expect(reloadedSkills).toHaveLength(1);
      expect(reloadedSkills[0].description).toBe("Updated skill");
    },
    15_000,
  );

  it(
    "triggers reload when a new skill file is added",
    async () => {
      setup();
      mkdirSync(dir, { recursive: true });

      const reloaded = new Promise<void>((resolve) => {
        const watcher = watchSkills(dir, () => {
          watcher.close();
          resolve();
        });
      });

      // Give watcher time to initialize (macOS FSEvents needs extra time in temp dirs)
      await new Promise((resolve) => setTimeout(resolve, 3000));

      writeSkill(
        "new-skill",
        `---
name: new-skill
description: Brand new
---

New content.
`,
      );

      await reloaded;
      // If we get here, the reload fired successfully
    },
    15_000,
  );
});
