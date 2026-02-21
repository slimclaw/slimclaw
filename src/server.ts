import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join } from "path";
import { fileURLToPath } from "url";

import type { SlimClawConfig } from "./config.js";
import type { Tool } from "./tools.js";
import type { Skill } from "./skills.js";
import type { LLMClient } from "./agent.js";
import { agentTurn } from "./agent.js";
import { createSession, loadSession, listSessions } from "./session.js";
import type { Session } from "./session.js";
import type { MemoryStore } from "./memory.js";
import type { Heartbeat } from "./heartbeat.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

interface ServerDeps {
  config: SlimClawConfig;
  tools: Tool[];
  skills: Skill[];
  memory: MemoryStore;
  heartbeat: Heartbeat;
  client: LLMClient;
}

export function startServer(deps: ServerDeps): ReturnType<typeof createServer> {
  const { config, tools, skills, memory, heartbeat, client } = deps;

  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  // Serve static files from public/
  app.use(express.static(join(__dirname, "..", "public")));

  // Track connected clients for broadcasting
  const clients = new Set<WebSocket>();

  // Broadcast helper for heartbeat
  const broadcast = (msg: string) => {
    const payload = JSON.stringify({ event: "heartbeat", data: { text: msg } });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  };

  // Start heartbeat
  heartbeat.start(
    config,
    {
      turn: async (message: string) => {
        const session = createSession();
        let result = "";
        for await (const event of agentTurn(session, message, config, client, tools, skills, "")) {
          if (event.type === "text") result += event.text;
        }
        return result;
      },
    },
    broadcast,
  );

  // WebSocket handling
  wss.on("connection", (ws) => {
    clients.add(ws);
    let currentSession: Session | null = null;

    ws.on("message", async (data) => {
      let msg: { method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ event: "error", data: { message: "Invalid JSON" } }));
        return;
      }

      try {
        switch (msg.method) {
          case "session.list": {
            const sessions = listSessions();
            ws.send(JSON.stringify({ event: "session.list", data: { sessions } }));
            break;
          }

          case "session.create": {
            currentSession = createSession();
            ws.send(
              JSON.stringify({
                event: "session.created",
                data: { sessionId: currentSession.id },
              }),
            );
            break;
          }

          case "chat.history": {
            const sessionId = msg.params?.sessionId as string | undefined;
            if (sessionId) {
              currentSession = loadSession(sessionId);
              ws.send(
                JSON.stringify({
                  event: "chat.history",
                  data: { messages: currentSession.messages, sessionId },
                }),
              );
            } else {
              ws.send(
                JSON.stringify({
                  event: "error",
                  data: { message: "sessionId required" },
                }),
              );
            }
            break;
          }

          case "chat.send": {
            const text = msg.params?.text as string;
            if (!text) {
              ws.send(
                JSON.stringify({ event: "error", data: { message: "text required" } }),
              );
              break;
            }

            // Create session if none exists
            if (!currentSession) {
              const sessionId = msg.params?.sessionId as string | undefined;
              if (sessionId) {
                try {
                  currentSession = loadSession(sessionId);
                } catch {
                  currentSession = createSession();
                }
              } else {
                currentSession = createSession();
              }
            }

            // Get memory context
            const memoryContext = memory.getRecentContext();

            // Run agent turn, streaming events to client
            for await (const event of agentTurn(
              currentSession,
              text,
              config,
              client,
              tools,
              skills,
              memoryContext,
            )) {
              if (ws.readyState !== WebSocket.OPEN) break;

              switch (event.type) {
                case "text":
                  ws.send(JSON.stringify({ event: "chunk", data: { text: event.text } }));
                  break;
                case "tool_start":
                  ws.send(
                    JSON.stringify({
                      event: "tool_start",
                      data: { name: event.name, input: event.input },
                    }),
                  );
                  break;
                case "tool_end":
                  ws.send(
                    JSON.stringify({
                      event: "tool_end",
                      data: { name: event.name, result: event.result },
                    }),
                  );
                  break;
              }
            }

            ws.send(
              JSON.stringify({
                event: "done",
                data: { sessionId: currentSession.id },
              }),
            );
            break;
          }

          default:
            ws.send(
              JSON.stringify({
                event: "error",
                data: { message: `Unknown method: ${msg.method}` },
              }),
            );
        }
      } catch (err) {
        ws.send(
          JSON.stringify({
            event: "error",
            data: {
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`SlimClaw running at http://${config.host}:${config.port}`);
  });

  return server;
}
