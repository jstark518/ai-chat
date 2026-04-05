import { Hono } from "hono";
import { getLocation, upsertLocation } from "../db.js";
import { log } from "../logger.js";

const location = new Hono();

location.get("/api/location", (c) => {
  log("[routes] GET /api/location");
  const loc = getLocation();
  if (!loc) {
    log("[routes] No location available");
    return c.json({ error: "No location available" }, 404);
  }
  return c.json(loc);
});

location.post("/api/location", async (c) => {
  const body = await c.req.json<{ latitude: number; longitude: number }>();
  log(`[routes] POST /api/location lat=${body.latitude} lng=${body.longitude}`);
  upsertLocation(body.latitude, body.longitude);
  return c.json({ ok: true });
});

export default location;
