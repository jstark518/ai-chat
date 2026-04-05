import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getMessages, insertMessage } from "../db.js";
import { broadcast } from "../ws.js";
import { log } from "../logger.js";
import { nudge } from "../agent.js";
import { resolveUserResponse } from "../mcp.js";

const messages = new Hono();

messages.get("/api/messages", (c) => {
  log("[routes] GET /api/messages");
  return c.json(getMessages());
});

messages.post("/api/messages", async (c) => {
  const body = await c.req.json<{ content: string }>();
  log(`[routes] POST /api/messages content="${body.content}"`);
  const message = {
    id: randomUUID(),
    role: "user" as const,
    content: body.content,
    type: "text" as const,
    timestamp: new Date().toISOString(),
  };
  insertMessage(message);
  broadcast(message);
  if (!resolveUserResponse(message.content)) {
    nudge();
  }
  return c.json(message, 201);
});

export default messages;
