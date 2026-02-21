import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tempDir, testConfig } from "./helpers.js";
import { Heartbeat, type AgentRunner } from "../src/heartbeat.js";

describe("Heartbeat", () => {
  let tmp: { path: string; cleanup: () => void };
  let memoryDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = tempDir();
    memoryDir = join(tmp.path, "memory");
    mkdirSync(memoryDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  it("does not start if heartbeat is disabled", () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: false, intervalMinutes: 1 },
    });

    const agent: AgentRunner = { turn: vi.fn() };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    // Advance time well past interval
    vi.advanceTimersByTime(120_000);

    expect(agent.turn).not.toHaveBeenCalled();
    heartbeat.stop();
  });

  it("fires after interval when enabled", async () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: true, intervalMinutes: 1 },
    });

    // Create HEARTBEAT.md
    writeFileSync(
      join(memoryDir, "HEARTBEAT.md"),
      "- [ ] Check for new emails\n",
    );

    const agent: AgentRunner = {
      turn: vi.fn().mockResolvedValue("I checked emails. Found 3 new messages."),
    };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    // Advance past the interval
    vi.advanceTimersByTime(60_000);
    // Allow promises to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(agent.turn).toHaveBeenCalledTimes(1);
    expect(agent.turn).toHaveBeenCalledWith(
      expect.stringContaining("[Heartbeat]"),
    );
    expect(agent.turn).toHaveBeenCalledWith(
      expect.stringContaining("Check for new emails"),
    );
    expect(broadcast).toHaveBeenCalledWith(
      "I checked emails. Found 3 new messages.",
    );

    heartbeat.stop();
  });

  it("suppresses HEARTBEAT_OK responses", async () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: true, intervalMinutes: 1 },
    });

    writeFileSync(join(memoryDir, "HEARTBEAT.md"), "- [ ] Check status\n");

    const agent: AgentRunner = {
      turn: vi.fn().mockResolvedValue("HEARTBEAT_OK"),
    };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(agent.turn).toHaveBeenCalledTimes(1);
    // HEARTBEAT_OK with short response should NOT broadcast
    expect(broadcast).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it("does not suppress long responses containing HEARTBEAT_OK", async () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: true, intervalMinutes: 1 },
    });

    writeFileSync(join(memoryDir, "HEARTBEAT.md"), "- [ ] Check all\n");

    const longResponse = "HEARTBEAT_OK but here's a very long report: " + "x".repeat(300);
    const agent: AgentRunner = {
      turn: vi.fn().mockResolvedValue(longResponse),
    };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    // Long response containing HEARTBEAT_OK should still broadcast
    expect(broadcast).toHaveBeenCalledWith(longResponse);

    heartbeat.stop();
  });

  it("skips when HEARTBEAT.md does not exist", async () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: true, intervalMinutes: 1 },
    });

    // No HEARTBEAT.md file
    const agent: AgentRunner = { turn: vi.fn() };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(agent.turn).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it("skips when HEARTBEAT.md is empty", async () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: true, intervalMinutes: 1 },
    });

    writeFileSync(join(memoryDir, "HEARTBEAT.md"), "   \n  \n");

    const agent: AgentRunner = { turn: vi.fn() };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(agent.turn).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it("stop clears the timer", () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: true, intervalMinutes: 1 },
    });

    writeFileSync(join(memoryDir, "HEARTBEAT.md"), "- [ ] Check\n");

    const agent: AgentRunner = {
      turn: vi.fn().mockResolvedValue("done"),
    };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);
    heartbeat.stop();

    // Advance past interval - should not fire
    vi.advanceTimersByTime(120_000);

    expect(agent.turn).not.toHaveBeenCalled();
  });

  it("fires multiple times at each interval", async () => {
    const heartbeat = new Heartbeat();
    const config = testConfig({
      memoryDir,
      heartbeat: { enabled: true, intervalMinutes: 1 },
    });

    writeFileSync(join(memoryDir, "HEARTBEAT.md"), "- [ ] Periodic check\n");

    const agent: AgentRunner = {
      turn: vi.fn().mockResolvedValue("All good, nothing to report here in detail."),
    };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    // Fire twice
    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(agent.turn).toHaveBeenCalledTimes(2);

    heartbeat.stop();
  });

  it("skips outside active hours", async () => {
    const heartbeat = new Heartbeat();

    // Set active hours to a window that doesn't include current time
    // Use a time range that's definitely not now
    const now = new Date();
    const currentHour = now.getHours();
    // Pick a 1-hour window that's 12 hours from now
    const activeStart = ((currentHour + 12) % 24).toString().padStart(2, "0") + ":00";
    const activeEnd = ((currentHour + 13) % 24).toString().padStart(2, "0") + ":00";

    const config = testConfig({
      memoryDir,
      heartbeat: {
        enabled: true,
        intervalMinutes: 1,
        activeHours: { start: activeStart, end: activeEnd },
      },
    });

    writeFileSync(join(memoryDir, "HEARTBEAT.md"), "- [ ] Check\n");

    const agent: AgentRunner = { turn: vi.fn() };
    const broadcast = vi.fn();

    heartbeat.start(config, agent, broadcast);

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(agent.turn).not.toHaveBeenCalled();

    heartbeat.stop();
  });
});
