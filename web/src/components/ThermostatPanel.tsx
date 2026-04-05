import type { Thermostat } from "../types";

interface Props {
  thermostat: Thermostat;
  updateThermostat: (data: { targetTemp?: number; mode?: string }) => Promise<void>;
}

const MODES = ["heat", "cool", "auto", "off"] as const;
const MODE_COLORS: Record<string, string> = {
  heat: "bg-amber-500",
  cool: "bg-blue-500",
  auto: "bg-emerald-500",
  off: "bg-gray-600",
};

export function ThermostatPanel({ thermostat, updateThermostat }: Props) {
  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span className="text-red-400">🌡️</span> Thermostat
      </h2>

      <div className="flex items-center justify-center gap-8 mb-6">
        <div className="text-center">
          <p className="text-4xl font-bold">{thermostat.currentTemp}°</p>
          <p className="text-sm text-gray-400 mt-1">Current</p>
        </div>
        <div className="text-center">
          <div className="flex items-center gap-3">
            <button
              onClick={() => updateThermostat({ targetTemp: thermostat.targetTemp - 1 })}
              className="w-10 h-10 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center text-xl font-bold transition-colors"
            >
              -
            </button>
            <span className="text-4xl font-bold text-blue-400">{thermostat.targetTemp}°</span>
            <button
              onClick={() => updateThermostat({ targetTemp: thermostat.targetTemp + 1 })}
              className="w-10 h-10 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center text-xl font-bold transition-colors"
            >
              +
            </button>
          </div>
          <p className="text-sm text-gray-400 mt-1">Target</p>
        </div>
      </div>

      <div className="flex gap-2 justify-center mb-4">
        {MODES.map((mode) => (
          <button
            key={mode}
            onClick={() => updateThermostat({ mode })}
            className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize transition-colors ${
              thermostat.mode === mode
                ? `${MODE_COLORS[mode]} text-white`
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      <p className="text-center text-sm text-gray-400">
        Humidity: {thermostat.humidity}%
      </p>
    </section>
  );
}
