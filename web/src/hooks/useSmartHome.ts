import { useState, useEffect, useCallback } from "react";
import type { SmartHomeState } from "../types";
import * as api from "../api";

const POLL_INTERVAL = 3000;

export function useSmartHome() {
  const [state, setState] = useState<SmartHomeState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.fetchState();
      setState(data);
    } catch (err) {
      console.error("Failed to fetch state:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  const updateLight = async (
    id: string,
    data: { on?: boolean; brightness?: number; color?: string }
  ) => {
    // Optimistic update
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        lights: prev.lights.map((l) =>
          l.id === id
            ? {
                ...l,
                ...(data.on !== undefined ? { on: data.on } : {}),
                ...(data.brightness !== undefined ? { brightness: data.brightness } : {}),
                ...(data.color !== undefined ? { color: data.color } : {}),
              }
            : l
        ),
      };
    });
    await api.updateLight(id, data);
  };

  const updateThermostat = async (data: {
    targetTemp?: number;
    mode?: string;
  }) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        thermostats: prev.thermostats.map((t) => ({
          ...t,
          ...(data.targetTemp !== undefined ? { targetTemp: data.targetTemp } : {}),
          ...(data.mode !== undefined ? { mode: data.mode as typeof t.mode } : {}),
        })),
      };
    });
    await api.updateThermostat(data);
  };

  const updateLock = async (id: string, locked: boolean) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        locks: prev.locks.map((l) =>
          l.id === id ? { ...l, locked } : l
        ),
      };
    });
    await api.updateLock(id, { locked });
  };

  const triggerSensor = async (id: string) => {
    await api.triggerSensor(id);
    refresh();
  };

  const activateScene = async (id: string) => {
    await api.activateScene(id);
    refresh();
  };

  const deleteDevice = async (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        lights: prev.lights.filter((l) => l.id !== id),
      };
    });
    await api.deleteDevice(id);
  };

  const setDeviceRoom = async (id: string, room: string) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        lights: prev.lights.map((l) =>
          l.id === id ? { ...l, room } : l
        ),
      };
    });
    await api.setDeviceRoom(id, room);
  };

  return {
    state,
    loading,
    updateLight,
    updateThermostat,
    updateLock,
    triggerSensor,
    activateScene,
    setDeviceRoom,
    deleteDevice,
  };
}
