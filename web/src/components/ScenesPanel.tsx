import type { Scene } from "../types";

interface Props {
  scenes: Scene[];
  activateScene: (id: string) => Promise<void>;
}

const SCENE_ICONS: Record<string, string> = {
  "Good Morning": "🌅",
  "Good Night": "🌙",
  "Movie Time": "🎬",
  "Away": "🏠",
};

export function ScenesPanel({ scenes, activateScene }: Props) {
  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span>🎭</span> Scenes
      </h2>
      <div className="grid grid-cols-2 gap-3">
        {scenes.map((scene) => (
          <button
            key={scene.id}
            onClick={() => activateScene(scene.id)}
            className="bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-gray-600 rounded-xl p-4 text-left transition-colors group"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">{SCENE_ICONS[scene.name] ?? "🎭"}</span>
              <span className="font-medium">{scene.name}</span>
            </div>
            <p className="text-xs text-gray-400 line-clamp-2">{scene.description}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
