import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { log } from "./logger.js";
import { randomUUID } from "node:crypto";
import {
  getLights, updateLight, updateLightRoom,
  getThermostat, updateThermostat,
  getSensors, updateSensor,
  getScenes, getScene,
  getGoveeDevices, getGoveeDevice, updateGoveeDeviceRoom, updateGoveeDeviceState,
  insertMessage,
} from "./db.js";
import type { Scene, Light, GoveeDeviceRecord, KasaDeviceRecord, DeviceInfo, Message } from "./db.js";
import { getKasaDevices, updateKasaDeviceRoom } from "./db.js";
import { kasaTurnOnOff, refreshAllKasaStates } from "./kasa.js";
import { broadcast, broadcastEvent } from "./ws.js";
import {
  isGoveeConfigured,
  turnOnOff,
  setBrightness,
  fetchAndSyncDevices,
  getCachedGoveeDevices,
  refreshAllDeviceStates,
} from "./govee.js";

// ============================================================
// Govee → Unified Light adapter
// ============================================================

interface UnifiedLight {
  id: string;
  name: string;
  room: string;
  on: boolean;
  brightness: number;
  color: string;
  source: "mock" | "govee" | "kasa";
  // Govee-specific identifiers (only present for source=govee)
  goveeSku?: string;
  goveeDevice?: string;
}

function goveeToLight(d: GoveeDeviceRecord): UnifiedLight {
  const state = d.cachedState ?? {};
  return {
    id: `govee:${d.sku}:${d.device}`,
    name: d.deviceName,
    room: d.room,
    on: state.powerSwitch === 1,
    brightness: typeof state.brightness === "number" ? state.brightness : 0,
    color: typeof state.colorRgb === "number"
      ? `#${(state.colorRgb as number).toString(16).padStart(6, "0")}`
      : "#FFFFFF",
    source: "govee",
    goveeSku: d.sku,
    goveeDevice: d.device,
  };
}

function mockToUnified(l: Light): UnifiedLight {
  return { ...l, source: "mock" };
}

export function getAllUnifiedLights(room?: string): UnifiedLight[] {
  // Mock lights
  let lights: UnifiedLight[] = getLights(room).map(mockToUnified);

  // Govee lights (type=light or light_strip)
  const goveeDevices = getGoveeDevices().filter(
    (d) => d.type === "light" || d.type === "light_strip" || d.type === "outdoor_light"
  );
  let goveeLights = goveeDevices.map(goveeToLight);
  if (room) {
    goveeLights = goveeLights.filter(
      (l) => l.room.toLowerCase() === room.toLowerCase()
    );
  }

  // Kasa devices (plugs and lights)
  let kasaLights = getKasaDevices().map(kasaToLight);
  if (room) {
    kasaLights = kasaLights.filter(
      (l) => l.room.toLowerCase() === room.toLowerCase()
    );
  }

  return [...lights, ...goveeLights, ...kasaLights];
}

function kasaToLight(d: KasaDeviceRecord): UnifiedLight {
  const state = d.cachedState ?? {};
  return {
    id: `kasa:${d.deviceId}`,
    name: d.alias,
    room: d.room,
    on: state.on === true,
    brightness: typeof state.brightness === "number" ? state.brightness : (state.on ? 100 : 0),
    color: "#FFFFFF",
    source: "kasa" as const,
  };
}

/** Parse a Kasa device ID: "kasa:DEVICE_ID" */
export function parseKasaId(id: string): string | null {
  if (!id.startsWith("kasa:")) return null;
  return id.slice(5);
}

/** Parse a unified light ID: "govee:SKU:DEVICE" or regular "light-1" */
export function parseGoveeId(id: string): { sku: string; device: string } | null {
  if (!id.startsWith("govee:")) return null;
  const parts = id.split(":");
  if (parts.length < 3) return null;
  return { sku: parts[1], device: parts.slice(2).join(":") };
}

// ============================================================
// Scene Application Logic
// ============================================================

/** Set a single unified light by ID (mock, govee, or kasa). Handles API calls + cache + broadcast.
 *  Returns true on success, false if the underlying API call failed. */
async function setUnifiedLight(id: string, data: { on?: boolean; brightness?: number; color?: string }): Promise<boolean> {
  const stateUpdate: Record<string, unknown> = {};
  if (data.on !== undefined) stateUpdate.on = data.on;
  if (data.brightness !== undefined) stateUpdate.brightness = data.brightness;
  if (data.color !== undefined) stateUpdate.color = data.color;

  const govee = parseGoveeId(id);
  if (govee) {
    try {
      if (data.on !== undefined) await turnOnOff(govee.sku, govee.device, data.on);
      if (data.brightness !== undefined) await setBrightness(govee.sku, govee.device, data.brightness);
      const device = getGoveeDevice(govee.device, govee.sku);
      const cached: Record<string, unknown> = { ...(device?.cachedState ?? {}) };
      if (data.on !== undefined) cached.powerSwitch = data.on ? 1 : 0;
      if (data.brightness !== undefined) cached.brightness = data.brightness;
      updateGoveeDeviceState(govee.device, govee.sku, cached);
      broadcastEvent({ event: "device_state_update", deviceId: id, state: stateUpdate });
      return true;
    } catch (err) {
      log(`[smarthome] Govee error for ${id}: ${err}`);
      return false;
    }
  }

  const kasaId = parseKasaId(id);
  if (kasaId) {
    try {
      if (data.on !== undefined) await kasaTurnOnOff(kasaId, data.on);
      broadcastEvent({ event: "device_state_update", deviceId: id, state: stateUpdate });
      return true;
    } catch (err) {
      log(`[smarthome] Kasa error for ${id}: ${err}`);
      return false;
    }
  }

  // Mock (synchronous, cannot fail)
  updateLight(id, data);
  broadcastEvent({ event: "device_state_update", deviceId: id, state: stateUpdate });
  return true;
}

/** Set multiple lights in parallel. Returns array of IDs whose API calls failed. */
async function setUnifiedLightsBatch(updates: Array<{ id: string; data: { on?: boolean; brightness?: number; color?: string } }>): Promise<string[]> {
  const results = await Promise.all(
    updates.map(async ({ id, data }) => ({ id, ok: await setUnifiedLight(id, data) }))
  );
  return results.filter((r) => !r.ok).map((r) => r.id);
}

export function applyScene(scene: Scene): void {
  log(`[smarthome] Applying scene: ${scene.name}`);
  const allLights = getAllUnifiedLights();

  if (scene.name === "Good Night" || scene.name === "Away") {
    // Turn off all lights in parallel
    setUnifiedLightsBatch(allLights.map((l) => ({ id: l.id, data: { on: false } }))).then((failed) => {
      if (failed.length > 0) log(`[smarthome] Scene "${scene.name}": ${failed.length} device(s) failed: ${failed.join(", ")}`);
    });
    updateThermostat({ targetTemp: scene.name === "Away" ? 65 : 68, mode: "auto" });
  } else if (scene.name === "Good Morning") {
    setUnifiedLightsBatch([
      { id: "light-5", data: { on: true, brightness: 100 } },
      { id: "light-1", data: { on: true, brightness: 80 } },
    ]).then((failed) => {
      if (failed.length > 0) log(`[smarthome] Scene "${scene.name}": ${failed.length} device(s) failed: ${failed.join(", ")}`);
    });
    updateThermostat({ targetTemp: 72, mode: "auto" });
  } else if (scene.name === "Movie Time") {
    setUnifiedLightsBatch([
      ...allLights.map((l) => ({ id: l.id, data: { on: false } })),
      { id: "light-2", data: { on: true, brightness: 20, color: "#FFD700" } },
    ]).then((failed) => {
      if (failed.length > 0) log(`[smarthome] Scene "${scene.name}": ${failed.length} device(s) failed: ${failed.join(", ")}`);
    });
  }
}

// ============================================================
// Register Smart Home Tools on MCP Server
// ============================================================

export function registerSmartHomeTools(server: McpServer): void {

  // --- get_lights ---
  server.tool(
    "get_lights",
    "Get the status of all smart lights in the home (including Govee lights), or filter by room. Each light has a 'source' field indicating if it's a mock or real Govee device.",
    {
      room: z.string().optional().describe("Filter lights by room name"),
    },
    async ({ room }) => {
      log("[mcp] Tool called: get_lights", JSON.stringify({ room }));
      // Refresh stale device states before returning
      if (isGoveeConfigured()) {
        try { await refreshAllDeviceStates(2 * 60 * 1000); } catch { /* ignore */ }
      }
      try { await refreshAllKasaStates(); } catch { /* ignore */ }
      const lights = getAllUnifiedLights(room);
      return { content: [{ type: "text" as const, text: JSON.stringify(lights) }] };
    }
  );

  // --- set_light ---
  server.tool(
    "set_light",
    "Control a single smart light — turn it on/off, set brightness, or change color. For multiple lights, use set_lights instead.",
    {
      id: z.string().describe("The light ID"),
      on: z.boolean().optional().describe("Turn the light on or off"),
      brightness: z.number().min(0).max(100).optional().describe("Brightness level 0–100"),
      color: z.string().optional().describe("Hex color code (e.g. '#FF0000' for red)"),
    },
    async ({ id, on, brightness, color }) => {
      log("[mcp] Tool called: set_light", JSON.stringify({ id, on, brightness, color }));
      const ok = await setUnifiedLight(id, { on, brightness, color });
      const text = ok
        ? `Light ${id} updated: ${JSON.stringify({ on, brightness, color })}`
        : `Light ${id} update FAILED (API error) — device may not have responded`;
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // --- set_lights (batch) ---
  server.tool(
    "set_lights",
    "Control multiple lights at once in parallel. Much faster than calling set_light repeatedly. Use this when turning off all office lights, setting a room to a color, etc.",
    {
      ids: z.array(z.string()).describe("Array of light IDs to control"),
      on: z.boolean().optional().describe("Turn all listed lights on or off"),
      brightness: z.number().min(0).max(100).optional().describe("Brightness level 0–100 for all"),
      color: z.string().optional().describe("Hex color code for all"),
    },
    async ({ ids, on, brightness, color }) => {
      log("[mcp] Tool called: set_lights", JSON.stringify({ ids, on, brightness, color }));
      const data = { on, brightness, color };
      const failed = await setUnifiedLightsBatch(ids.map((id) => ({ id, data })));
      const text = failed.length === 0
        ? `Updated ${ids.length} light(s) successfully`
        : `Updated ${ids.length - failed.length}/${ids.length} light(s). ${failed.length} failed (API error): ${failed.join(", ")}`;
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // --- set_room ---
  server.tool(
    "set_room",
    "Assign a device to a room. Works with any light (mock, Govee, or Kasa).",
    {
      id: z.string().describe("The device ID (e.g. 'light-1', 'govee:SKU:DEVICE', or 'kasa:DEVICE_ID')"),
      room: z.string().describe("The room name to assign (e.g. 'Living Room', 'Bedroom', 'Patio')"),
    },
    async ({ id, room }) => {
      log("[mcp] Tool called: set_room", JSON.stringify({ id, room }));

      const govee = parseGoveeId(id);
      if (govee) {
        updateGoveeDeviceRoom(govee.device, govee.sku, room);
        return { content: [{ type: "text" as const, text: `Govee device assigned to room "${room}"` }] };
      }

      const kasaId = parseKasaId(id);
      if (kasaId) {
        updateKasaDeviceRoom(kasaId, room);
        return { content: [{ type: "text" as const, text: `Kasa device assigned to room "${room}"` }] };
      }

      const light = updateLightRoom(id, room);
      if (light) {
        return { content: [{ type: "text" as const, text: `Light "${light.name}" assigned to room "${room}"` }] };
      }

      return { content: [{ type: "text" as const, text: `Device '${id}' not found` }] };
    }
  );

  // --- get_all_devices ---
  server.tool(
    "get_all_devices",
    "Get a summary of ALL smart home devices — mock lights, thermostat, locks, sensors, scenes, and any connected Govee devices (lights, appliances, sensors, etc.).",
    {},
    async () => {
      log("[mcp] Tool called: get_all_devices");
      const sensors = getSensors();
      const scenes = getScenes();
      const summary: Record<string, unknown> = {
        lights: getAllUnifiedLights(),
        thermostat: getThermostat(),
        ...(sensors.length > 0 && { sensors }),
        ...(scenes.length > 0 && { scenes }),
      };

      const goveeDevices = getGoveeDevices();
      const nonLightGovee = goveeDevices.filter(
        (d) => d.type !== "light" && d.type !== "light_strip" && d.type !== "outdoor_light"
      );
      if (nonLightGovee.length > 0) {
        summary.goveeAppliances = nonLightGovee.map((d) => ({
          id: `govee:${d.sku}:${d.device}`,
          name: d.deviceName,
          type: d.type,
          sku: d.sku,
          state: d.cachedState,
        }));
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
    }
  );

  // --- sync_devices ---
  server.tool(
    "sync_devices",
    "Sync Govee devices from the cloud. Fetches the latest device list and their current states. Only needed if new devices were added or you want fresh state.",
    {},
    async () => {
      log("[mcp] Tool called: sync_devices");
      if (!isGoveeConfigured()) {
        return { content: [{ type: "text" as const, text: "Govee API key not configured. No devices to sync." }] };
      }
      try {
        const devices = await fetchAndSyncDevices();
        await refreshAllDeviceStates(0);
        const updated = getCachedGoveeDevices();
        return { content: [{ type: "text" as const, text: `Synced ${devices.length} device(s): ${updated.map((d) => `${d.deviceName} (${d.type})`).join(", ")}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Sync error: ${err}` }] };
      }
    }
  );

  // --- show_devices ---
  server.tool(
    "show_devices",
    "Show the user a visual smart home card in the chat with device status and interactive controls. The user can tap controls to toggle lights, lock doors, etc. Returns a summary of what was shown.",
    {
      room: z.string().optional().describe("Filter devices by room name. Omit to show all devices."),
      title: z.string().optional().describe("Title for the card (e.g. 'Living Room' or 'All Devices')"),
    },
    async ({ room, title }) => {
      log("[mcp] Tool called: show_devices", JSON.stringify({ room, title }));
      const devices: DeviceInfo[] = [];

      // Lights
      const lights = getAllUnifiedLights(room);
      for (const l of lights) {
        devices.push({
          id: l.id, name: l.name, deviceType: "light", room: l.room,
          on: l.on, brightness: l.brightness, color: l.color, source: l.source,
        });
      }

      // Thermostat (always include unless room-filtered and doesn't match)
      if (!room) {
        const therm = getThermostat();
        if (therm) {
          devices.push({
            id: therm.id, name: therm.name, deviceType: "thermostat",
            currentTemp: therm.currentTemp, targetTemp: therm.targetTemp,
            mode: therm.mode, humidity: therm.humidity,
          });
        }
      }

      // Sensors
      const sensors = getSensors(undefined, room);
      for (const s of sensors) {
        devices.push({
          id: s.id, name: s.name, deviceType: "sensor", room: s.room,
          sensorType: s.type, state: s.state, lastTriggered: s.lastTriggered,
        });
      }

      const cardTitle = title ?? (room ? `${room} Devices` : "Smart Home Status");
      const message: Message = {
        id: randomUUID(),
        role: "assistant",
        content: cardTitle,
        type: "smart_home_card",
        devices,
        timestamp: new Date().toISOString(),
      };
      insertMessage(message);
      broadcastEvent({ event: "typing", typing: false });
      broadcast(message);

      return {
        content: [{
          type: "text" as const,
          text: `Showed ${devices.length} device(s) in card: "${cardTitle}" (${devices.filter(d => d.deviceType === "light").length} lights, ${devices.filter(d => d.deviceType === "lock").length} locks, ${devices.filter(d => d.deviceType === "thermostat").length} thermostats, ${devices.filter(d => d.deviceType === "sensor").length} sensors)`,
        }],
      };
    }
  );

  // --- get_thermostat ---
  server.tool(
    "get_thermostat",
    "Get the current thermostat status including temperature, target, mode, and humidity.",
    {},
    async () => {
      log("[mcp] Tool called: get_thermostat");
      const therm = getThermostat();
      if (!therm) {
        return { content: [{ type: "text" as const, text: "No thermostat configured." }] };
      }
      const drifted = Math.round((therm.currentTemp + (Math.random() - 0.5) * 0.5) * 10) / 10;
      updateThermostat({ currentTemp: drifted });
      return { content: [{ type: "text" as const, text: JSON.stringify(getThermostat()) }] };
    }
  );

  // --- set_thermostat ---
  server.tool(
    "set_thermostat",
    "Set the thermostat target temperature and/or mode.",
    {
      targetTemp: z.number().min(50).max(90).optional().describe("Target temperature in °F"),
      mode: z.enum(["heat", "cool", "auto", "off"]).optional().describe("Thermostat mode"),
    },
    async ({ targetTemp, mode }) => {
      log("[mcp] Tool called: set_thermostat", JSON.stringify({ targetTemp, mode }));
      const therm = updateThermostat({ targetTemp, mode });
      if (!therm) {
        return { content: [{ type: "text" as const, text: "No thermostat configured." }] };
      }
      const stateUpdate: Record<string, unknown> = {};
      if (targetTemp !== undefined) stateUpdate.targetTemp = targetTemp;
      if (mode !== undefined) stateUpdate.mode = mode;
      broadcastEvent({ event: "device_state_update", deviceId: therm.id, state: stateUpdate });
      return { content: [{ type: "text" as const, text: JSON.stringify(therm) }] };
    }
  );


  // --- get_sensors ---
  server.tool(
    "get_sensors",
    "Get the status of all home sensors (motion, door, window, temperature, humidity). Optionally filter by type or room.",
    {
      type: z.enum(["motion", "door", "window", "temperature", "humidity"]).optional().describe("Filter by sensor type"),
      room: z.string().optional().describe("Filter by room name"),
    },
    async ({ type, room }) => {
      log("[mcp] Tool called: get_sensors", JSON.stringify({ type, room }));
      for (const s of getSensors("motion")) {
        if (Math.random() < 0.1) {
          updateSensor(s.id, { state: "detected", lastTriggered: new Date().toISOString() });
        }
      }
      const sensors = getSensors(type, room);
      return { content: [{ type: "text" as const, text: JSON.stringify(sensors) }] };
    }
  );

  // --- get_scenes ---
  server.tool(
    "get_scenes",
    "List all available smart home scenes/routines.",
    {},
    async () => {
      log("[mcp] Tool called: get_scenes");
      return { content: [{ type: "text" as const, text: JSON.stringify(getScenes()) }] };
    }
  );

  // --- activate_scene ---
  server.tool(
    "activate_scene",
    "Activate a smart home scene/routine by name or ID. This will execute all actions in the scene.",
    {
      id: z.string().describe("The scene ID or name (e.g. 'scene-1' or 'Good Night')"),
    },
    async ({ id }) => {
      log("[mcp] Tool called: activate_scene", JSON.stringify({ id }));
      const scene = getScene(id);
      if (!scene) return { content: [{ type: "text" as const, text: `Scene '${id}' not found` }] };
      applyScene(scene);
      return {
        content: [{
          type: "text" as const,
          text: `Scene "${scene.name}" activated. Actions: ${scene.actions.join("; ")}`,
        }],
      };
    }
  );
}
