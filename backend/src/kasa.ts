import TplinkSmarthome from "tplink-smarthome-api";
const { Client } = TplinkSmarthome;
import { log } from "./logger.js";
import {
  getKasaDevices, getKasaDevice, upsertKasaDevice, updateKasaDeviceState,
} from "./db.js";
import type { KasaDeviceRecord } from "./db.js";
import { broadcastEvent } from "./ws.js";

const client = new Client();

function classifyKasaType(model: string): string {
  const m = model.toUpperCase();
  if (m.startsWith("HS") || m.startsWith("KP") || m.startsWith("EP")) return "plug";
  if (m.startsWith("LB") || m.startsWith("KL")) return "light";
  return "plug";
}

interface DiscoveredDevice {
  deviceId?: string;
  childId?: string;
  id?: string;
  host: string;
  alias: string;
  model: string;
  deviceType?: string;
  relayState?: number;
}

/** Discover Kasa devices on the local network. Upserts all found devices to DB. */
export async function discoverKasaDevices(timeoutMs = 10_000): Promise<KasaDeviceRecord[]> {
  log(`[kasa] Starting LAN discovery (${timeoutMs / 1000}s timeout)...`);

  return new Promise((resolve) => {
    const found: KasaDeviceRecord[] = [];

    const discovery = client.startDiscovery({ discoveryTimeout: timeoutMs });

    discovery.on("device-new", (device: DiscoveredDevice) => {
      // Use `id` which is unique per outlet for power strips, or deviceId for standalone
      const uniqueId = device.id ?? device.childId ?? device.deviceId ?? device.host;
      const childId = device.childId ?? null;
      const type = classifyKasaType(device.model ?? "");
      log(`[kasa] Found: ${device.alias} (${device.model}) at ${device.host} id=${uniqueId}${childId ? ` child=${childId}` : ""}`);

      const record = upsertKasaDevice(uniqueId, device.host, device.alias, type, device.model ?? null);
      found.push(record);

      // Fetch initial state
      fetchKasaDeviceState(uniqueId, device.host, childId).catch(() => {});
    });

    setTimeout(() => {
      discovery.removeAllListeners();
      client.stopDiscovery();
      log(`[kasa] Discovery complete. Found ${found.length} device(s)`);
      resolve(found);
    }, timeoutMs + 500);
  });
}

/** Fetch current state of a Kasa device. For power strip outlets, pass childId. */
export async function fetchKasaDeviceState(deviceId: string, host?: string, childId?: string | null): Promise<Record<string, unknown>> {
  const device = getKasaDevice(deviceId);
  const deviceHost = host ?? device?.host;
  if (!deviceHost) throw new Error(`Kasa device ${deviceId} not found`);

  // Determine childId from the deviceId if not passed
  const resolvedChildId = childId ?? (deviceId.length > 40 ? deviceId : null);

  log(`[kasa] Fetching state for ${deviceId} at ${deviceHost}${resolvedChildId ? ` child=${resolvedChildId}` : ""}`);

  const kasaDevice = await client.getDevice({ host: deviceHost, childId: resolvedChildId ?? undefined });
  const sysInfo = await kasaDevice.getSysInfo() as Record<string, unknown>;

  const state: Record<string, unknown> = {};

  // For power strips with children, find the specific child's state
  if (resolvedChildId && Array.isArray(sysInfo.children)) {
    const child = (sysInfo.children as Array<Record<string, unknown>>).find(
      (c) => c.id === resolvedChildId || c.id === resolvedChildId.slice(-2)
    );
    if (child) {
      state.on = child.state === 1;
      state.alias = child.alias;
    } else {
      state.on = sysInfo.relay_state === 1;
    }
  } else if (sysInfo.light_state) {
    // Bulb
    const ls = sysInfo.light_state as Record<string, unknown>;
    state.on = ls.on_off === 1;
    if (ls.brightness !== undefined) state.brightness = ls.brightness;
  } else {
    // Simple plug
    state.on = sysInfo.relay_state === 1;
  }

  state.model = sysInfo.model;
  updateKasaDeviceState(deviceId, state);
  log(`[kasa] Cached state for ${deviceId}: on=${state.on}`);

  return state;
}

/** Turn a Kasa device on or off. */
export async function kasaTurnOnOff(deviceId: string, on: boolean): Promise<void> {
  const device = getKasaDevice(deviceId);
  if (!device) throw new Error(`Kasa device ${deviceId} not found`);

  // Determine if this is a power strip child
  const childId = deviceId.length > 40 ? deviceId : undefined;

  log(`[kasa] ${on ? "Turning on" : "Turning off"} ${device.alias} at ${device.host}${childId ? ` child=${childId}` : ""}`);
  const kasaDevice = await client.getDevice({ host: device.host, childId });
  await kasaDevice.setPowerState(on);

  // Update cached state
  const cached = { ...(device.cachedState ?? {}), on };
  updateKasaDeviceState(deviceId, cached);
}

/** Get cached Kasa devices from DB (no network calls). */
export function getCachedKasaDevices(): KasaDeviceRecord[] {
  return getKasaDevices();
}

/** Refresh state for all cached Kasa devices in parallel. Broadcasts WS events. */
export async function refreshAllKasaStates(): Promise<void> {
  const devices = getKasaDevices();
  if (devices.length === 0) return;

  const results = await Promise.allSettled(
    devices.map(async (d) => {
      await fetchKasaDeviceState(d.deviceId, d.host);
      const updated = getKasaDevice(d.deviceId);
      if (updated?.cachedState) {
        broadcastEvent({
          event: "device_state_update",
          deviceId: `kasa:${d.deviceId}`,
          state: { on: updated.cachedState.on },
        });
      }
    })
  );
  const refreshed = results.filter((r) => r.status === "fulfilled").length;
  log(`[kasa] Refreshed state for ${refreshed}/${devices.length} device(s)`);
}
