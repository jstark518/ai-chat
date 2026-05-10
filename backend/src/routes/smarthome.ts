import { Hono } from "hono";
import {
  updateLight, updateLightRoom,
  getThermostat, updateThermostat,
  getSensors, updateSensor,
  getScenes, getScene,
  getGoveeDevice, updateGoveeDeviceRoom, updateGoveeDeviceState,
  deleteLight, deleteGoveeDevice,
  updateKasaDeviceRoom, deleteKasaDevice,
} from "../db.js";
import { applyScene, getAllUnifiedLights, parseGoveeId, parseKasaId } from "../smarthome.js";
import { log } from "../logger.js";
import { isGoveeConfigured, turnOnOff, setBrightness, setColorRgb } from "../govee.js";

const smarthome = new Hono();

// Combined state endpoint — returns unified lights (mock + Govee)
smarthome.get("/api/smarthome/state", (c) => {
  // Simulate slight temp drift on read
  const therm = getThermostat();
  if (therm) {
    const drifted = Math.round((therm.currentTemp + (Math.random() - 0.5) * 0.5) * 10) / 10;
    updateThermostat({ currentTemp: drifted });
  }

  const current = getThermostat();
  return c.json({
    lights: getAllUnifiedLights(),
    thermostats: current ? [current] : [],
    locks: [],
    sensors: getSensors(),
    scenes: getScenes(),
  });
});

// --- Lights (unified — mock + Govee) ---
smarthome.put("/api/smarthome/lights/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ on?: boolean; brightness?: number; color?: string }>();
  log(`[routes] PUT /api/smarthome/lights/${id}`, JSON.stringify(body));

  const govee = parseGoveeId(id);
  if (govee) {
    if (!isGoveeConfigured()) return c.json({ error: "Govee API key not configured" }, 400);
    try {
      // Build optimistic state update
      const stateUpdate: Record<string, unknown> = {};
      if (body.on !== undefined) {
        await turnOnOff(govee.sku, govee.device, body.on);
        stateUpdate.powerSwitch = body.on ? 1 : 0;
      }
      if (body.brightness !== undefined) {
        await setBrightness(govee.sku, govee.device, body.brightness);
        stateUpdate.brightness = body.brightness;
      }
      if (body.color !== undefined) {
        const hex = body.color.replace("#", "");
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        await setColorRgb(govee.sku, govee.device, r, g, b);
        stateUpdate.colorRgb = (r << 16) | (g << 8) | b;
      }
      // Update cached state in DB so the next poll reflects the change
      if (Object.keys(stateUpdate).length > 0) {
        const device = getGoveeDevice(govee.device, govee.sku);
        const merged = { ...(device?.cachedState ?? {}), ...stateUpdate };
        updateGoveeDeviceState(govee.device, govee.sku, merged);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  }

  const light = updateLight(id, body);
  if (!light) return c.json({ error: "Light not found" }, 404);
  return c.json(light);
});

// --- Room assignment (any device) ---
smarthome.put("/api/smarthome/devices/:id/room", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ room: string }>();
  log(`[routes] PUT /api/smarthome/devices/${id}/room`, JSON.stringify(body));

  const govee = parseGoveeId(id);
  if (govee) {
    updateGoveeDeviceRoom(govee.device, govee.sku, body.room);
    return c.json({ ok: true, room: body.room });
  }

  const kasaId = parseKasaId(id);
  if (kasaId) {
    updateKasaDeviceRoom(kasaId, body.room);
    return c.json({ ok: true, room: body.room });
  }

  const light = updateLightRoom(id, body.room);
  if (light) return c.json({ ok: true, room: body.room });

  return c.json({ error: "Device not found" }, 404);
});

// --- Delete device ---
smarthome.delete("/api/smarthome/devices/:id", (c) => {
  const id = c.req.param("id");
  log(`[routes] DELETE /api/smarthome/devices/${id}`);

  const govee = parseGoveeId(id);
  if (govee) {
    const deleted = deleteGoveeDevice(govee.device, govee.sku);
    if (!deleted) return c.json({ error: "Device not found" }, 404);
    return c.json({ ok: true });
  }

  const kasaId = parseKasaId(id);
  if (kasaId) {
    const deleted = deleteKasaDevice(kasaId);
    if (!deleted) return c.json({ error: "Device not found" }, 404);
    return c.json({ ok: true });
  }

  const deleted = deleteLight(id);
  if (!deleted) return c.json({ error: "Device not found" }, 404);
  return c.json({ ok: true });
});

// --- Thermostat ---
smarthome.put("/api/smarthome/thermostat", async (c) => {
  const body = await c.req.json<{ targetTemp?: number; mode?: string }>();
  log("[routes] PUT /api/smarthome/thermostat", JSON.stringify(body));
  const therm = updateThermostat(body);
  if (!therm) return c.json({ error: "No thermostat configured" }, 404);
  return c.json(therm);
});

// --- Sensors ---
smarthome.post("/api/smarthome/sensors/:id/trigger", async (c) => {
  const id = c.req.param("id");
  log(`[routes] POST /api/smarthome/sensors/${id}/trigger`);
  const sensors = getSensors();
  const sensor = sensors.find((s) => s.id === id);
  if (!sensor) return c.json({ error: "Sensor not found" }, 404);

  let newState = sensor.state;
  if (sensor.type === "motion") {
    newState = "detected";
  } else if (sensor.type === "door" || sensor.type === "window") {
    newState = sensor.state === "open" ? "closed" : "open";
  }
  const updated = updateSensor(id, { state: newState, lastTriggered: new Date().toISOString() });
  return c.json(updated);
});

// --- Scenes ---
smarthome.post("/api/smarthome/scenes/:id/activate", async (c) => {
  const id = c.req.param("id");
  log(`[routes] POST /api/smarthome/scenes/${id}/activate`);
  const scene = getScene(id);
  if (!scene) return c.json({ error: "Scene not found" }, 404);
  applyScene(scene);
  return c.json({ activated: scene.name, actions: scene.actions });
});

export default smarthome;
