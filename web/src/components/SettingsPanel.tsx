import { useState, useEffect } from "react";

interface Settings {
  goveeApiKey: string | null;
  goveeConfigured: boolean;
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings);
  }, []);

  const saveApiKey = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goveeApiKey: apiKeyInput }),
      });
      const data = await res.json();
      setSettings((s) => s ? { ...s, goveeConfigured: data.goveeConfigured, goveeApiKey: apiKeyInput.slice(0, 4) + "..." + apiKeyInput.slice(-4) } : null);
      setApiKeyInput("");
      setMessage("API key saved");
    } catch {
      setMessage("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span>&#9881;&#65039;</span> Settings
      </h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">
            Govee API Key
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={settings?.goveeApiKey ?? "Enter your Govee API key"}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={saveApiKey}
              disabled={saving || !apiKeyInput}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {settings?.goveeConfigured
              ? `Connected (${settings.goveeApiKey})`
              : "Not configured — get your key from the Govee Home app"}
          </p>
          {message && (
            <p className="text-xs text-emerald-400 mt-1">{message}</p>
          )}
        </div>
      </div>
    </section>
  );
}
