/**
 * index.ts — Entry point. Loads config, initializes all subsystems,
 * and starts the web server.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { loadConfig } from "./config.js";
import { initDatabase } from "./db.js";
import { MemoryStore, createMemoryTools } from "./memory.js";
import { createBuiltinTools } from "./tools.js";
import type { Tool } from "./tools.js";
import { loadSkills, watchSkills, skillTools } from "./skills.js";
import { startAllMCPServers, stopAllMCPServers } from "./mcp.js";
import { createLLMClient } from "./agent.js";
import { createSubAgentTool } from "./subagent.js";
import { Heartbeat } from "./heartbeat.js";
import { startServer } from "./server.js";

async function main() {
  // 1. Load config
  const config = loadConfig("slimclaw.json");

  // 2. Ensure data directory exists
  const dataDir = join(homedir(), ".slimclaw");
  mkdirSync(dataDir, { recursive: true });

  // 3. Init database
  const db = initDatabase(join(dataDir, "slimclaw.db"));

  // 4. Init memory
  const memory = new MemoryStore(db, config.memoryDir);
  memory.reindex();
  memory.startWatching();

  // 5. Create LLM client
  const client = createLLMClient(config);

  // 6. Load built-in tools
  const builtinTools = createBuiltinTools(config);

  // 7. Load skills
  let skills = loadSkills(config.skillsDir);

  // 8. Start MCP servers
  const mcpServers = await startAllMCPServers(config);
  const mcpTools = mcpServers.flatMap((s) => s.tools);

  // 9. Combine all tools (mutable array so hot-reload can update it)
  const staticTools: Tool[] = [
    ...builtinTools,
    ...mcpTools,
    ...createMemoryTools(memory),
    createSubAgentTool(config, client, builtinTools),
  ];
  const allTools: Tool[] = [...staticTools, ...skillTools(skills)];

  // 10. Watch skills for hot reload — rebuild tools array in-place
  const skillWatcher = watchSkills(config.skillsDir, (reloaded) => {
    skills = reloaded;
    allTools.length = 0;
    allTools.push(...staticTools, ...skillTools(skills));
    console.log(`Skills reloaded: ${skills.map((s) => s.name).join(", ")}`);
  });

  // 11. Create heartbeat
  const heartbeat = new Heartbeat();

  // 12. Start server
  const server = startServer({
    config,
    client,
    tools: allTools,
    skills,
    memory,
    heartbeat,
  });

  // 13. Graceful shutdown
  const shutdown = async () => {
    heartbeat.stop();
    await stopAllMCPServers(mcpServers);
    memory.stopWatching();
    await skillWatcher.close();
    db.close();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  // SIGTERM is not supported on Windows
  if (process.platform !== "win32") {
    process.on("SIGTERM", shutdown);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
