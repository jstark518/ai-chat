import { useState, useEffect, useCallback } from "react";

interface KasaDevice {
  deviceId: string;
  host: string;
  alias: string;
  type: string;
  model: string | null;
  cachedState: Record<string, unknown> | null;
  stateFetchedAt: string | null;
  room: string;
  lastSynced: string;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function KasaPanel() {
  const [devices, setDevices] = useState<KasaDevice[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [refreshingDevice, setRefreshingDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCached = useCallback(async () => {
    try {
      const res = await fetch("/api/kasa/devices");
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) setDevices(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadCached();
  }, [loadCached]);

  const discover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const res = await fetch("/api/kasa/devices/discover", { method: "POST" });
      if (!res.ok) throw new Error("Discovery failed");
      const data = await res.json();
      setDevices(data);
      // Reload to get updated state
      setTimeout(loadCached, 2000);
    } catch (err) {
      setError(String(err));
    } finally {
      setDiscovering(false);
    }
  };

  const refreshDevice = async (id: string) => {
    setRefreshingDevice(id);
    try {
      const res = await fetch(`/api/kasa/devices/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      if (res.ok) {
        const updated = await res.json();
        setDevices((prev) =>
          prev?.map((d) => d.deviceId === id ? { ...d, cachedState: updated.cachedState, stateFetchedAt: updated.stateFetchedAt } : d) ?? null
        );
      }
    } catch { /* ignore */ }
    setRefreshingDevice(null);
  };

  const controlDevice = async (id: string, on: boolean) => {
    // Optimistic update
    setDevices((prev) =>
      prev?.map((d) => d.deviceId === id ? { ...d, cachedState: { ...(d.cachedState ?? {}), on } } : d) ?? null
    );
    try {
      await fetch(`/api/kasa/devices/${encodeURIComponent(id)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "power", on }),
      });
    } catch (err) {
      console.error("Kasa control error:", err);
    }
  };

  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span>🔌</span> Kasa Devices
          {devices && <span className="text-sm font-normal text-gray-400">({devices.length})</span>}
        </h2>
        <button
          onClick={discover}
          disabled={discovering}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50"
        >
          {discovering ? "Discovering..." : "Discover on LAN"}
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {!devices && (
        <p className="text-sm text-gray-400">No Kasa devices cached. Click "Discover on LAN" to scan your network.</p>
      )}

      {devices && devices.length === 0 && (
        <p className="text-sm text-gray-400">No devices found. Make sure your Kasa devices are on the same network.</p>
      )}

      {devices && devices.length > 0 && (
        <div className="space-y-2">
          {devices.map((d) => {
            const isOn = d.cachedState?.on === true;
            const isRefreshing = refreshingDevice === d.deviceId;

            return (
              <div
                key={d.deviceId}
                onClick={() => refreshDevice(d.deviceId)}
                className={`bg-gray-800 rounded-xl p-4 border transition-colors cursor-pointer hover:border-gray-600 ${
                  isRefreshing ? "border-blue-700/50" : isOn ? "border-emerald-800/50" : "border-gray-700"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${isOn ? "bg-emerald-500" : "bg-gray-500"}`} />
                      <p className="font-medium">{d.alias}</p>
                      {isRefreshing && <span className="text-xs text-blue-400 animate-pulse">refreshing...</span>}
                    </div>
                    <p className="text-xs text-gray-500">
                      {d.model ?? "Unknown"} · {d.host} · {d.type}
                      {d.stateFetchedAt && ` · ${timeAgo(d.stateFetchedAt)}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); controlDevice(d.deviceId, !isOn); }}
                    className={`w-12 h-7 rounded-full transition-colors flex items-center px-0.5 cursor-pointer ${
                      isOn ? "bg-emerald-500" : "bg-gray-600"
                    }`}
                  >
                    <span className={`w-6 h-6 rounded-full bg-white transition-transform pointer-events-none ${
                      isOn ? "translate-x-5" : "translate-x-0"
                    }`} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
