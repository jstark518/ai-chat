import { useRef, useCallback, useState } from "react";
import type { Light } from "../types";

interface Props {
  lights: Light[];
  updateLight: (id: string, data: { on?: boolean; brightness?: number }) => Promise<void>;
  setDeviceRoom: (id: string, room: string) => Promise<void>;
  deleteDevice: (id: string) => Promise<void>;
}

export function LightsPanel({ lights, updateLight, setDeviceRoom, deleteDevice }: Props) {
  const rooms = [...new Set(lights.map((l) => l.room))].sort((a, b) => {
    // "Unassigned" always last
    if (a === "Unassigned") return 1;
    if (b === "Unassigned") return -1;
    return a.localeCompare(b);
  });

  // Collect all known room names for the dropdown
  const knownRooms = rooms.filter((r) => r !== "Unassigned");

  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span className="text-yellow-400">💡</span> Lights
        <span className="text-sm font-normal text-gray-400">({lights.length})</span>
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {rooms.map((room) => (
          <div key={room}>
            <h3 className="text-sm font-medium text-gray-400 mb-2">{room}</h3>
            <div className="space-y-3">
              {lights
                .filter((l) => l.room === room)
                .map((light) => (
                  <LightCard
                    key={light.id}
                    light={light}
                    updateLight={updateLight}
                    setDeviceRoom={setDeviceRoom}
                    deleteDevice={deleteDevice}
                    knownRooms={knownRooms}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LightCard({
  light,
  updateLight,
  setDeviceRoom,
  deleteDevice,
  knownRooms,
}: {
  light: Light;
  updateLight: Props["updateLight"];
  setDeviceRoom: Props["setDeviceRoom"];
  deleteDevice: Props["deleteDevice"];
  knownRooms: string[];
}) {
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [editingRoom, setEditingRoom] = useState(false);
  const [roomInput, setRoomInput] = useState(light.room);

  const handleBrightness = useCallback(
    (value: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateLight(light.id, { brightness: value });
      }, 200);
    },
    [light.id, updateLight]
  );

  const handleRoomChange = async (newRoom: string) => {
    if (newRoom && newRoom !== light.room) {
      await setDeviceRoom(light.id, newRoom);
    }
    setEditingRoom(false);
  };

  return (
    <div className={`bg-gray-800 rounded-xl p-3 border transition-colors ${
      light.on ? "border-emerald-800/50" : "border-gray-700"
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0 flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
            light.on ? "bg-emerald-500" : "bg-gray-500"
          }`} />
          <div className="min-w-0">
            <span className="text-sm font-medium truncate block">{light.name}</span>
            <span className="text-[10px] text-gray-500">
              {light.source === "govee" ? (
                <span className="text-emerald-500">Govee</span>
              ) : (
                "Mock"
              )}
              {light.on ? ` · ${light.brightness}%` : " · Off"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => updateLight(light.id, { on: !light.on })}
          className={`w-11 h-6 rounded-full transition-colors flex-shrink-0 flex items-center px-0.5 cursor-pointer ${
            light.on ? "bg-emerald-500" : "bg-gray-600"
          }`}
        >
          <span
            className={`w-5 h-5 rounded-full bg-white transition-transform pointer-events-none ${
              light.on ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>
      {light.on && (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            defaultValue={light.brightness}
            onChange={(e) => handleBrightness(Number(e.target.value))}
            className="w-full h-1.5 bg-gray-700 rounded-full appearance-none accent-yellow-400"
          />
          <span className="text-xs text-gray-400 w-8 text-right">{light.brightness}%</span>
        </div>
      )}
      {/* Room assignment + delete */}
      <div className="mt-2 flex items-center justify-between">
        {editingRoom ? (
          <div className="flex gap-1 flex-1">
            <input
              type="text"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRoomChange(roomInput);
                if (e.key === "Escape") setEditingRoom(false);
              }}
              placeholder="Room name"
              autoFocus
              list={`rooms-${light.id}`}
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-0.5 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
            />
            <datalist id={`rooms-${light.id}`}>
              {knownRooms.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <button
              onClick={() => handleRoomChange(roomInput)}
              className="text-xs text-blue-400 hover:text-blue-300 px-1"
            >
              ✓
            </button>
            <button
              onClick={() => setEditingRoom(false)}
              className="text-xs text-gray-500 hover:text-gray-400 px-1"
            >
              ✕
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={() => { setRoomInput(light.room); setEditingRoom(true); }}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              📍 {light.room}
            </button>
            <button
              type="button"
              onClick={() => { if (confirm(`Delete "${light.name}"?`)) deleteDevice(light.id); }}
              className="text-[10px] text-gray-600 hover:text-red-400 transition-colors"
            >
              🗑
            </button>
          </>
        )}
      </div>
    </div>
  );
}
