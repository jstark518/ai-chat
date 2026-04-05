import type { Lock } from "../types";

interface Props {
  locks: Lock[];
  updateLock: (id: string, locked: boolean) => Promise<void>;
}

export function LocksPanel({ locks, updateLock }: Props) {
  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span>🔒</span> Locks
      </h2>
      <div className="space-y-3">
        {locks.map((lock) => (
          <div
            key={lock.id}
            className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex items-center justify-between"
          >
            <div>
              <p className="font-medium">{lock.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {new Date(lock.lastChanged).toLocaleTimeString()}
              </p>
            </div>
            <button
              onClick={() => updateLock(lock.id, !lock.locked)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                lock.locked
                  ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
                  : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
              }`}
            >
              {lock.locked ? "Locked" : "Unlocked"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
