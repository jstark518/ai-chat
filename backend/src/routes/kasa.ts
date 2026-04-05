import { Hono } from "hono";
import { log } from "../logger.js";
import { getKasaDevice } from "../db.js";
import {
  discoverKasaDevices,
  getCachedKasaDevices,
  fetchKasaDeviceState,
  kasaTurnOnOff,
} from "../kasa.js";

const kasa = new Hono();

// Cached devices from DB
kasa.get("/api/kasa/devices", (c) => {
  log("[routes] GET /api/kasa/devices");
  return c.json(getCachedKasaDevices());
});

// Discover devices on the LAN
kasa.post("/api/kasa/devices/discover", async (c) => {
  log("[routes] POST /api/kasa/devices/discover");
  try {
    const devices = await discoverKasaDevices();
    return c.json(devices);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Refresh a single device's state
kasa.post("/api/kasa/devices/:id/refresh", async (c) => {
  const id = c.req.param("id");
  log(`[routes] POST /api/kasa/devices/${id}/refresh`);
  try {
    await fetchKasaDeviceState(id);
    const updated = getKasaDevice(id);
    return c.json(updated);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Control a device
kasa.post("/api/kasa/devices/:id/control", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ action: string; on?: boolean }>();
  log(`[routes] POST /api/kasa/devices/${id}/control action=${body.action}`);
  try {
    if (body.action === "power") {
      await kasaTurnOnOff(id, body.on ?? true);
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default kasa;
