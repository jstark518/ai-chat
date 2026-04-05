import type { SmartHomeState, Light, Thermostat, Lock, Sensor } from "./types";

export async function fetchState(): Promise<SmartHomeState> {
  const res = await fetch("/api/smarthome/state");
  return res.json();
}

export async function deleteDevice(id: string): Promise<void> {
  await fetch(`/api/smarthome/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function setDeviceRoom(
  id: string,
  room: string,
): Promise<void> {
  await fetch(`/api/smarthome/devices/${encodeURIComponent(id)}/room`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room }),
  });
}

export async function updateLight(
  id: string,
  data: { on?: boolean; brightness?: number; color?: string }
): Promise<Light> {
  const res = await fetch(`/api/smarthome/lights/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function updateThermostat(
  data: { targetTemp?: number; mode?: string }
): Promise<Thermostat> {
  const res = await fetch("/api/smarthome/thermostat", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function updateLock(
  id: string,
  data: { locked: boolean }
): Promise<Lock> {
  const res = await fetch(`/api/smarthome/locks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function triggerSensor(id: string): Promise<Sensor> {
  const res = await fetch(`/api/smarthome/sensors/${id}/trigger`, {
    method: "POST",
  });
  return res.json();
}

export async function activateScene(
  id: string
): Promise<{ activated: string; actions: string[] }> {
  const res = await fetch(`/api/smarthome/scenes/${id}/activate`, {
    method: "POST",
  });
  return res.json();
}
