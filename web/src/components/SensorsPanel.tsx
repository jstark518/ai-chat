import type { Sensor } from "../types";

interface Props {
  sensors: Sensor[];
  triggerSensor: (id: string) => Promise<void>;
}

const TYPE_ICONS: Record<string, string> = {
  motion: "👁️",
  door: "🚪",
  window: "🪟",
  temperature: "🌡️",
  humidity: "💧",
};

const STATE_COLORS: Record<string, string> = {
  clear: "text-gray-400",
  detected: "text-amber-400",
  open: "text-amber-400",
  closed: "text-emerald-400",
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function SensorsPanel({ sensors, triggerSensor }: Props) {
  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span>📡</span> Sensors
      </h2>
      <div className="space-y-3">
        {sensors.map((sensor) => (
          <div
            key={sensor.id}
            className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <span className="text-xl">{TYPE_ICONS[sensor.type] ?? "📡"}</span>
              <div>
                <p className="font-medium">{sensor.name}</p>
                <p className="text-xs text-gray-400">{sensor.room}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className={`text-sm font-medium capitalize ${STATE_COLORS[sensor.state] ?? "text-gray-400"}`}>
                  {sensor.state}
                </p>
                <p className="text-xs text-gray-500">{timeAgo(sensor.lastTriggered)}</p>
              </div>
              <button
                onClick={() => triggerSensor(sensor.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
              >
                Simulate
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
