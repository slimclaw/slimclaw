import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { SlimClawConfig } from "./config.js";

export interface AgentRunner {
  turn(message: string): Promise<string>;
}

function isWithinActiveHours(activeHours: { start: string; end: string }): boolean {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = activeHours.start.split(":").map(Number);
  const [endH, endM] = activeHours.end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  // Wraps midnight (e.g. 22:00 - 06:00)
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(
    config: SlimClawConfig,
    agent: AgentRunner,
    broadcast: (msg: string) => void,
  ): void {
    if (!config.heartbeat.enabled) return;

    const intervalMs = config.heartbeat.intervalMinutes * 60 * 1000;

    this.timer = setInterval(async () => {
      // Check active hours
      if (config.heartbeat.activeHours && !isWithinActiveHours(config.heartbeat.activeHours)) {
        return;
      }

      // Read HEARTBEAT.md
      const heartbeatPath = join(config.memoryDir, "HEARTBEAT.md");
      if (!existsSync(heartbeatPath)) return;
      const checklist = readFileSync(heartbeatPath, "utf-8").trim();
      if (!checklist) return;

      // Run agent turn
      const response = await agent.turn(
        `[Heartbeat] Review this checklist and act on anything that needs attention:\n\n${checklist}\n\nRespond with HEARTBEAT_OK if nothing needs attention.`,
      );

      // Suppress if HEARTBEAT_OK and short
      if (response.includes("HEARTBEAT_OK") && response.length < 300) return;

      // Deliver to connected WebSocket clients
      broadcast(response);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
