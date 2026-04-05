import { log, error as logError } from "./logger.js";
import { getSetting, setSetting, syncGoveeDevices, getGoveeDevices as getCachedDevices, getGoveeDevice, updateGoveeDeviceState, isGoveeStateStale } from "./db.js";
import { broadcastEvent } from "./ws.js";
import type { GoveeDeviceRecord, GoveeCapability } from "./db.js";

const GOVEE_BASE = "https://openapi.api.govee.com";

export function setGoveeApiKey(key: string) {
  setSetting("govee_api_key", key);
  log(`[govee] API key set (${key.slice(0, 4)}...)`);
}

export function getGoveeApiKey(): string | null {
  return getSetting("govee_api_key");
}

export function isGoveeConfigured(): boolean {
  const key = getGoveeApiKey();
  return key !== null && key.length > 0;
}

// Types re-exported from db.ts
export type { GoveeCapability, GoveeDeviceRecord } from "./db.js";

export interface GoveeApiDevice {
  sku: string;
  device: string;
  deviceName: string;
  capabilities: GoveeCapability[];
}

// --- API Methods ---

async function goveeRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const key = getGoveeApiKey();
  if (!key) throw new Error("Govee API key not configured");

  const url = `${GOVEE_BASE}${path}`;
  log(`[govee] ${method} ${path}`);

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Govee-API-Key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    logError(`[govee] API error ${res.status}: ${text}`);
    throw new Error(`Govee API error ${res.status}: ${text}`);
  }

  return res.json();
}

/** Fetch devices from Govee API and sync to local DB. Returns enriched records with type classification. */
export async function fetchAndSyncDevices(): Promise<GoveeDeviceRecord[]> {
  const result = await goveeRequest("GET", "/router/api/v1/user/devices") as {
    code: number;
    data: GoveeApiDevice[];
  };
  log(`[govee] Fetched ${result.data.length} device(s) from API`);
  return syncGoveeDevices(result.data);
}

/** Get cached devices from local DB (no API call). */
export function getCachedGoveeDevices(): GoveeDeviceRecord[] {
  return getCachedDevices();
}

/** Fetch fresh state from the Govee API and cache it in the DB. */
export async function fetchDeviceState(sku: string, device: string): Promise<GoveeApiDevice> {
  const result = await goveeRequest("POST", "/router/api/v1/device/state", {
    requestId: crypto.randomUUID(),
    payload: { sku, device },
  }) as {
    code: number;
    payload: GoveeApiDevice;
  };

  // Parse state from capabilities and cache
  const state: Record<string, unknown> = {};
  const caps = Array.isArray(result.payload?.capabilities) ? result.payload.capabilities : [];
  for (const cap of caps) {
    if (cap.state?.value !== undefined) {
      state[cap.instance] = cap.state.value;
    }
  }
  updateGoveeDeviceState(device, sku, state);
  log(`[govee] Cached state for ${sku}/${device}: ${JSON.stringify(state)}`);

  return result.payload;
}

/**
 * Get device state — returns cached state from DB if fresh enough,
 * otherwise fetches from API and caches. Default max age: 5 minutes.
 */
export async function getDeviceStateCached(sku: string, device: string, maxAgeMs = 5 * 60 * 1000): Promise<Record<string, unknown> | null> {
  if (!isGoveeStateStale(device, sku, maxAgeMs)) {
    const cached = getGoveeDevice(device, sku);
    if (cached?.cachedState) {
      log(`[govee] Using cached state for ${sku}/${device} (fetched ${cached.stateFetchedAt})`);
      return cached.cachedState;
    }
  }

  // Fetch fresh
  try {
    await fetchDeviceState(sku, device);
    const updated = getGoveeDevice(device, sku);
    return updated?.cachedState ?? null;
  } catch (err) {
    logError(`[govee] Failed to fetch state for ${sku}/${device}:`, err);
    // Fall back to stale cache if available
    const cached = getGoveeDevice(device, sku);
    return cached?.cachedState ?? null;
  }
}

/** Refresh state for all cached devices (only stale ones). Broadcasts updates via WebSocket. */
export async function refreshAllDeviceStates(maxAgeMs = 5 * 60 * 1000): Promise<void> {
  const devices = getCachedDevices();
  const stale = devices.filter((d) => isGoveeStateStale(d.device, d.sku, maxAgeMs));
  if (stale.length === 0) return;

  const results = await Promise.allSettled(
    stale.map(async (d) => {
      await fetchDeviceState(d.sku, d.device);
      const updated = getGoveeDevice(d.device, d.sku);
      if (updated?.cachedState) {
        const deviceId = `govee:${d.sku}:${d.device}`;
        const state: Record<string, unknown> = {};
        const cs = updated.cachedState;
        if (cs.powerSwitch !== undefined) state.on = cs.powerSwitch === 1;
        if (cs.brightness !== undefined) state.brightness = cs.brightness;
        if (cs.colorRgb !== undefined) {
          const rgb = cs.colorRgb as number;
          state.color = `#${rgb.toString(16).padStart(6, "0")}`;
        }
        broadcastEvent({ event: "device_state_update", deviceId, state });
      }
    })
  );
  const fetched = results.filter((r) => r.status === "fulfilled").length;
  log(`[govee] Refreshed state for ${fetched}/${devices.length} device(s)`);
}

export async function controlDevice(
  sku: string,
  device: string,
  capability: { type: string; instance: string; value: unknown }
): Promise<void> {
  await goveeRequest("POST", "/router/api/v1/device/control", {
    requestId: crypto.randomUUID(),
    payload: {
      sku,
      device,
      capability,
    },
  });
}

// --- Convenience helpers ---

export async function turnOnOff(sku: string, device: string, on: boolean): Promise<void> {
  await controlDevice(sku, device, {
    type: "devices.capabilities.on_off",
    instance: "powerSwitch",
    value: on ? 1 : 0,
  });
}

export async function setBrightness(sku: string, device: string, brightness: number): Promise<void> {
  await controlDevice(sku, device, {
    type: "devices.capabilities.range",
    instance: "brightness",
    value: Math.max(1, Math.min(100, brightness)),
  });
}

export async function setColorRgb(sku: string, device: string, r: number, g: number, b: number): Promise<void> {
  const value = (r << 16) | (g << 8) | b;
  await controlDevice(sku, device, {
    type: "devices.capabilities.color_setting",
    instance: "colorRgb",
    value,
  });
}
