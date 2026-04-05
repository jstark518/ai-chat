import { Hono } from "hono";
import { log } from "../logger.js";
import {
  setGoveeApiKey,
  getGoveeApiKey,
  isGoveeConfigured,
  fetchAndSyncDevices,
  getCachedGoveeDevices,
  refreshAllDeviceStates,
  fetchDeviceState,
  turnOnOff,
  setBrightness,
  setColorRgb,
  controlDevice,
} from "../govee.js";
import { getGoveeDevice } from "../db.js";

const govee = new Hono();

// --- Settings ---
govee.get("/api/settings", (c) => {
  return c.json({
    goveeApiKey: getGoveeApiKey() ? `${getGoveeApiKey()!.slice(0, 4)}...${getGoveeApiKey()!.slice(-4)}` : null,
    goveeConfigured: isGoveeConfigured(),
  });
});

govee.put("/api/settings", async (c) => {
  const body = await c.req.json<{ goveeApiKey?: string }>();
  log("[routes] PUT /api/settings");
  if (body.goveeApiKey !== undefined) {
    setGoveeApiKey(body.goveeApiKey);
  }
  return c.json({ ok: true, goveeConfigured: isGoveeConfigured() });
});

// --- Govee Devices ---

// Get cached devices from DB (includes cached state — no API calls)
govee.get("/api/govee/devices", (c) => {
  log("[routes] GET /api/govee/devices");
  const devices = getCachedGoveeDevices();
  return c.json(devices);
});

// Fetch fresh devices from Govee API, sync to DB, and refresh all device states
govee.post("/api/govee/devices/sync", async (c) => {
  log("[routes] POST /api/govee/devices/sync");
  if (!isGoveeConfigured()) {
    return c.json({ error: "Govee API key not configured" }, 400);
  }
  try {
    await fetchAndSyncDevices();
    // Also refresh state for all devices
    await refreshAllDeviceStates(0); // force refresh all
    // Return devices with fresh state
    return c.json(getCachedGoveeDevices());
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Refresh a single device's state from the Govee API
govee.post("/api/govee/devices/:sku/:device/refresh", async (c) => {
  const sku = c.req.param("sku");
  const device = c.req.param("device");
  log(`[routes] POST /api/govee/devices/${sku}/${device}/refresh`);
  if (!isGoveeConfigured()) {
    return c.json({ error: "Govee API key not configured" }, 400);
  }
  try {
    await fetchDeviceState(sku, device);
    const updated = getGoveeDevice(device, sku);
    return c.json(updated);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

govee.post("/api/govee/devices/:sku/:device/control", async (c) => {
  const sku = c.req.param("sku");
  const device = c.req.param("device");
  const body = await c.req.json<{
    action: string;
    on?: boolean;
    brightness?: number;
    r?: number;
    g?: number;
    b?: number;
    capabilityType?: string;
    instance?: string;
    value?: unknown;
  }>();
  log(`[routes] POST /api/govee/devices/${sku}/${device}/control action=${body.action}`);
  if (!isGoveeConfigured()) {
    return c.json({ error: "Govee API key not configured" }, 400);
  }
  try {
    switch (body.action) {
      case "power":
        await turnOnOff(sku, device, body.on ?? true);
        break;
      case "brightness":
        await setBrightness(sku, device, body.brightness ?? 50);
        break;
      case "color":
        await setColorRgb(sku, device, body.r ?? 255, body.g ?? 255, body.b ?? 255);
        break;
      case "raw":
        if (body.capabilityType && body.instance) {
          await controlDevice(sku, device, {
            type: body.capabilityType,
            instance: body.instance,
            value: body.value,
          });
        }
        break;
      default:
        return c.json({ error: `Unknown action: ${body.action}` }, 400);
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default govee;
