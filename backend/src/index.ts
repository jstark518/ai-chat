import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import { parseGoveeId, parseKasaId } from "./smarthome.js";
import { isGoveeConfigured, turnOnOff, setBrightness } from "./govee.js";
import { kasaTurnOnOff } from "./kasa.js";
import messages from "./routes/messages.js";
import location from "./routes/location.js";
import smarthome from "./routes/smarthome.js";
import goveeRoutes from "./routes/govee.js";
import agentRoutes from "./routes/agent.js";
import kasaRoutes from "./routes/kasa.js";
import tasksRoutes from "./routes/tasks.js";
import { addClient, removeClient } from "./ws.js";
import { startAgentLoop, nudge as nudgeAgent } from "./agent.js";
import { initMCP, resolveUserResponse, resolveLocationRequest } from "./mcp.js";
import { insertMessage, updateLight, updateThermostat, logToolCall, upsertLocation } from "./db.js";
import { broadcast, broadcastEvent } from "./ws.js";
import { randomUUID } from "node:crypto";
import { log, warn, error as logError } from "./logger.js";

async function handleDeviceControl(deviceId: string, action: string, params: Record<string, unknown>) {
  logToolCall(randomUUID(), "[user_device_control]", { deviceId, action, ...params });

  // Build state update to broadcast
  const stateUpdate: Record<string, unknown> = {};

  const govee = parseGoveeId(deviceId);
  if (govee && isGoveeConfigured()) {
    if (action === "toggle" || action === "power") {
      await turnOnOff(govee.sku, govee.device, params.on as boolean);
      stateUpdate.on = params.on;
    } else if (action === "brightness") {
      await setBrightness(govee.sku, govee.device, params.brightness as number);
      stateUpdate.brightness = params.brightness;
    }
  }

  const kasaId = parseKasaId(deviceId);
  if (kasaId) {
    if (action === "toggle" || action === "power") {
      await kasaTurnOnOff(kasaId, params.on as boolean);
      stateUpdate.on = params.on;
    }
  } else if (!govee) {
    // Mock devices
    if (action === "toggle" || action === "power") {
      updateLight(deviceId, { on: params.on as boolean });
      stateUpdate.on = params.on;
    } else if (action === "brightness") {
      updateLight(deviceId, { brightness: params.brightness as number });
      stateUpdate.brightness = params.brightness;
    } else if (action === "thermostat") {
      if (params.targetTemp !== undefined) stateUpdate.targetTemp = params.targetTemp;
      if (params.mode !== undefined) stateUpdate.mode = params.mode;
      updateThermostat({
        targetTemp: params.targetTemp as number | undefined,
        mode: params.mode as string | undefined,
      });
    }
  }

  // Broadcast state update so all clients (including iOS cards) can update
  broadcastEvent({ event: "device_state_update", deviceId, state: stateUpdate });
}

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });


// CORS for web dashboard
app.use("/api/*", cors());

// REST routes
app.route("/", messages);
app.route("/", location);
app.route("/", smarthome);
app.route("/", goveeRoutes);
app.route("/", agentRoutes);
app.route("/", kasaRoutes);
app.route("/", tasksRoutes);

// Health check
app.get("/health", (c) => c.json({ ok: true }));

// --- Read receipt debounce ---
// Collect incoming read IDs and broadcast in a single batch after a short delay.
let pendingReadIds = new Set<string>();
let readDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const READ_DEBOUNCE_MS = 500;

function enqueueReadReceipts(ids: string[]) {
  for (const id of ids) pendingReadIds.add(id);
  if (readDebounceTimer) return; // already scheduled
  readDebounceTimer = setTimeout(() => {
    if (pendingReadIds.size > 0) {
      const batch = Array.from(pendingReadIds);
      pendingReadIds = new Set();
      log(`[server] Read receipt batch: ${batch.length} message(s)`);
      broadcastEvent({ event: "read", messageIds: batch });
    }
    readDebounceTimer = null;
  }, READ_DEBOUNCE_MS);
}

// WebSocket endpoint
app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      addClient(ws);
    },
    onMessage(event, _ws) {
      const raw = String(event.data);
      log(`[server] WebSocket message received: ${raw}`);
      try {
        const data = JSON.parse(raw);
        // Handle events from clients
        if (data.event === "read" && Array.isArray(data.messageIds)) {
          enqueueReadReceipts(data.messageIds);
        } else if (data.event === "device_control") {
          log(`[server] Device control: ${data.deviceId} ${data.action}`, JSON.stringify(data.params));
          handleDeviceControl(data.deviceId, data.action, data.params ?? {});
        } else if (data.event === "location_response" && typeof data.latitude === "number" && typeof data.longitude === "number") {
          log(`[server] Location response: ${data.requestId} ${data.latitude},${data.longitude}`);
          upsertLocation(data.latitude, data.longitude);
          resolveLocationRequest(data.requestId, data.latitude, data.longitude);
        } else if (data.content) {
          const message = {
            id: data.id || randomUUID(),
            role: "user" as const,
            content: data.content,
            type: "text" as const,
            timestamp: data.timestamp || new Date().toISOString(),
          };
          insertMessage(message);
          broadcast(message);
          // Try to resolve a pending tool first; otherwise nudge the agent loop
          if (!resolveUserResponse(message.content)) {
            nudgeAgent();
          }
        } else {
          warn("[server] WebSocket message missing 'content' field");
        }
      } catch (err) {
        logError("[server] WebSocket message parse error:", err);
      }
    },
    onClose(_event, ws) {
      log("[server] WebSocket connection closed");
      removeClient(ws);
    },
  }))
);

const PORT = Number(process.env.PORT) || 8136;

log(`[server] Starting on port ${PORT}...`);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  log(`[server] HTTP server running on http://localhost:${info.port}`);
});

injectWebSocket(server);
log("[server] WebSocket upgrade handler attached");

// Initialize MCP and start agent loop
import { getSetting } from "./db.js";
initMCP().then(({ client: mcpClient, createAgentMcpServer }) => {
  const intervalMs = Number(getSetting("agent_interval_ms") ?? 30000);
  startAgentLoop(mcpClient, createAgentMcpServer, intervalMs);
  log("[server] Startup complete");
}).catch((err) => {
  logError("[server] Failed to initialize MCP:", err);
  process.exit(1);
});
