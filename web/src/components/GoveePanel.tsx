import { useState, useEffect } from "react";

interface GoveeCapability {
  type: string;
  instance: string;
  parameters?: {
    dataType: string;
    options?: Array<{ name: string; value: number | string }>;
    range?: { min: number; max: number; precision: number };
  };
  state?: { value: unknown };
}

interface GoveeDevice {
  sku: string;
  device: string;
  deviceName: string;
  type: string;
  room: string;
  capabilities: GoveeCapability[];
  cachedState: Record<string, unknown> | null;
  stateFetchedAt: string | null;
  lastSynced: string;
}

const TYPE_ICONS: Record<string, string> = {
  light: "💡",
  light_strip: "🌈",
  outdoor_light: "🔦",
  humidifier: "💨",
  air_purifier: "🌬️",
  heater: "🔥",
  fan: "🌀",
  tower_fan: "🌀",
  sensor: "📡",
  thermometer: "🌡️",
  kettle: "☕",
  ice_maker: "🧊",
  aroma_diffuser: "🌸",
  dehumidifier: "💧",
  unknown: "📦",
};

const TYPE_LABELS: Record<string, string> = {
  light: "Light",
  light_strip: "Light Strip",
  outdoor_light: "Outdoor Light",
  humidifier: "Humidifier",
  air_purifier: "Air Purifier",
  heater: "Heater",
  fan: "Fan",
  tower_fan: "Tower Fan",
  sensor: "Sensor",
  thermometer: "Thermometer",
  kettle: "Kettle",
  ice_maker: "Ice Maker",
  aroma_diffuser: "Aroma Diffuser",
  dehumidifier: "Dehumidifier",
  unknown: "Device",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function GoveePanel() {
  const [devices, setDevices] = useState<GoveeDevice[] | null>(null);
  const [localBrightness, setLocalBrightness] = useState<Record<string, number>>({});
  const [syncing, setSyncing] = useState(false);
  const [refreshingDevice, setRefreshingDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);

  // Check config + load cached devices once on mount
  useEffect(() => {
    (async () => {
      const settingsRes = await fetch("/api/settings");
      const settings = await settingsRes.json();
      setConfigured(settings.goveeConfigured);

      if (settings.goveeConfigured) {
        const devicesRes = await fetch("/api/govee/devices");
        const data = await devicesRes.json();
        if (Array.isArray(data)) setDevices(data);
      }
    })();
  }, []);

  const syncDevices = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/govee/devices/sync", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Sync failed");
      }
      const data = await res.json();
      setDevices(data);
      setLocalBrightness({});
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  };

  const refreshDevice = async (sku: string, device: string) => {
    const key = `${sku}::${device}`;
    setRefreshingDevice(key);
    try {
      const res = await fetch(`/api/govee/devices/${sku}/${encodeURIComponent(device)}/refresh`, {
        method: "POST",
      });
      if (res.ok) {
        const updated = await res.json();
        setDevices((prev) =>
          prev?.map((d) =>
            d.sku === sku && d.device === device
              ? { ...d, cachedState: updated.cachedState, stateFetchedAt: updated.stateFetchedAt }
              : d
          ) ?? null
        );
      }
    } catch { /* ignore */ }
    setRefreshingDevice(null);
  };

  const controlDevice = async (sku: string, device: string, action: string, params: Record<string, unknown> = {}) => {
    try {
      await fetch(`/api/govee/devices/${sku}/${encodeURIComponent(device)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...params }),
      });
    } catch (err) {
      console.error("Control error:", err);
    }
  };

  if (!configured) {
    return (
      <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
        <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
          <span>🟢</span> Govee Devices
        </h2>
        <p className="text-sm text-gray-400">
          Set your Govee API key in Settings to connect your devices.
        </p>
      </section>
    );
  }

  // Group devices by type
  const grouped = (devices ?? []).reduce<Record<string, GoveeDevice[]>>((acc, d) => {
    (acc[d.type] ??= []).push(d);
    return acc;
  }, {});

  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span>🟢</span> Govee Devices
          {devices && <span className="text-sm font-normal text-gray-400">({devices.length})</span>}
        </h2>
        <button
          onClick={syncDevices}
          disabled={syncing}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync from Govee"}
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {!devices && (
        <p className="text-sm text-gray-400">No devices cached. Click "Sync from Govee" to fetch your devices.</p>
      )}

      {devices && devices.length === 0 && (
        <p className="text-sm text-gray-400">No devices found. Try syncing again.</p>
      )}

      {Object.entries(grouped).map(([type, typeDevices]) => (
        <div key={type} className="mb-4 last:mb-0">
          <h3 className="text-sm font-medium text-gray-400 mb-2 flex items-center gap-1.5">
            <span>{TYPE_ICONS[type] ?? "📦"}</span>
            {TYPE_LABELS[type] ?? type}
            <span className="text-xs text-gray-500">({typeDevices.length})</span>
          </h3>
          <div className="space-y-2">
            {typeDevices.map((d) => {
              const key = `${d.sku}::${d.device}`;
              const state = d.cachedState;
              const isRefreshing = refreshingDevice === key;
              const hasPower = d.capabilities.some((c) => c.type === "devices.capabilities.on_off");
              const hasBrightness = d.capabilities.some(
                (c) => c.type === "devices.capabilities.range" && c.instance === "brightness"
              );
              const hasColor = d.capabilities.some(
                (c) => c.type === "devices.capabilities.color_setting"
              );
              const hasColorTemp = d.capabilities.some(
                (c) => c.instance === "colorTemperatureK"
              );

              const isOn = state?.powerSwitch === 1;
              const brightness = localBrightness[key] ?? (typeof state?.brightness === "number" ? state.brightness : 50);
              const isOnline = state?.online !== false;

              return (
                <div
                  key={key}
                  onClick={() => refreshDevice(d.sku, d.device)}
                  className={`bg-gray-800 rounded-xl p-4 border transition-colors cursor-pointer hover:border-gray-600 ${
                    isRefreshing ? "border-blue-700/50" :
                    !isOnline && state ? "border-red-900/50 opacity-60" :
                    isOn ? "border-emerald-800/50" : "border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{d.deviceName}</p>
                        {state && (
                          <span className={`inline-block w-2 h-2 rounded-full ${
                            !isOnline ? "bg-red-500" : isOn ? "bg-emerald-500" : "bg-gray-500"
                          }`} />
                        )}
                        {isRefreshing && (
                          <span className="text-xs text-blue-400 animate-pulse">refreshing...</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">
                        {d.sku}
                        {hasColor && " · RGB"}
                        {hasColorTemp && " · Color Temp"}
                        {hasBrightness && " · Dimmable"}
                        {d.stateFetchedAt && ` · ${timeAgo(d.stateFetchedAt)}`}
                      </p>
                    </div>
                    {hasPower && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); controlDevice(d.sku, d.device, "power", { on: !isOn }); }}
                        className={`w-12 h-7 rounded-full transition-colors flex items-center px-0.5 cursor-pointer ${
                          isOn ? "bg-emerald-500" : "bg-gray-600"
                        }`}
                      >
                        <span
                          className={`w-6 h-6 rounded-full bg-white transition-transform pointer-events-none ${
                            isOn ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    )}
                  </div>
                  {hasBrightness && (
                    <div className="flex items-center gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="range"
                        min={1}
                        max={100}
                        value={brightness}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setLocalBrightness((prev) => ({ ...prev, [key]: val }));
                          clearTimeout((e.target as unknown as { _t: number })._t);
                          (e.target as unknown as { _t: number })._t = setTimeout(
                            () => controlDevice(d.sku, d.device, "brightness", { brightness: val }),
                            300
                          ) as unknown as number;
                        }}
                        className="w-full h-1.5 bg-gray-700 rounded-full appearance-none accent-emerald-400"
                      />
                      <span className="text-xs text-gray-400 w-8 text-right">{brightness}%</span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {d.capabilities.slice(0, 8).map((c, i) => (
                      <span key={i} className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">
                        {c.instance}
                      </span>
                    ))}
                    {d.capabilities.length > 8 && (
                      <span className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">
                        +{d.capabilities.length - 8} more
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
