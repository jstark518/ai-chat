import type { WSContext } from "hono/ws";
import type { Message } from "./db.js";
import { log, warn } from "./logger.js";

const clients = new Set<WSContext>();

export function addClient(ws: WSContext) {
  clients.add(ws);
  log(`[ws] Client added (${clients.size} total)`);
}

export function removeClient(ws: WSContext) {
  clients.delete(ws);
  log(`[ws] Client removed (${clients.size} total)`);
}

export function broadcast(message: Message) {
  const data = JSON.stringify(message);
  log(`[ws] Broadcasting to ${clients.size} client(s): role=${message.role} content="${message.content}"`);
  broadcastRaw(data);
}

export type WSEvent =
  | { event: "typing"; typing: boolean }
  | { event: "read"; messageIds: string[] }
  | { event: "device_control"; deviceId: string; action: string; params: Record<string, unknown> }
  | { event: "device_state_update"; deviceId: string; state: Record<string, unknown> }
  | { event: "request_location"; requestId: string };

export function broadcastEvent(event: WSEvent) {
  const data = JSON.stringify(event);
  log(`[ws] Broadcasting event to ${clients.size} client(s): ${data}`);
  broadcastRaw(data);
}

function broadcastRaw(data: string) {
  for (const client of clients) {
    try {
      client.send(data);
    } catch (err) {
      warn(`[ws] Failed to send to client, removing`, err);
      clients.delete(client);
    }
  }
}
