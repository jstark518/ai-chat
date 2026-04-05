import { useState, useEffect, useCallback } from "react";
import type React from "react";

interface Memory {
  id: string;
  content: string;
  category: string;
  pinned: boolean;
  createdAt: string;
  deletedAt: string | null;
}

interface Callback {
  id: string;
  reason: string;
  fireAt: string;
  fired: boolean;
  createdAt: string;
}

interface ToolCallEntry {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string | null;
  calledAt: string;
}

interface AgentConfig {
  intervalMs: number;
  systemPrompt: string;
  dreamPrompt: string;
  model: string;
  tickModel: string;
  dreamModel: string;
  nextTickAt: number | null;
  running: boolean;
}

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 3.5" },
];

// Lightweight markdown renderer for **bold**, headers, bullets, and hr.
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Split on **bold**, `code`
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++} className="text-white font-semibold">{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={key++} className="bg-gray-900 text-amber-300 px-1 rounded text-[10px]">{token.slice(1, -1)}</code>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      blocks.push(<hr key={key++} className="my-2 border-gray-700" />);
      i++;
      continue;
    }

    // Headers
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = headerMatch[2];
      const sizeClass = level === 1 ? "text-base font-bold" : level === 2 ? "text-sm font-bold" : "text-xs font-semibold uppercase tracking-wide";
      const colorClass = level <= 2 ? "text-purple-200" : "text-purple-300";
      blocks.push(
        <div key={key++} className={`${sizeClass} ${colorClass} mt-2 mb-1`}>
          {renderInline(content)}
        </div>
      );
      i++;
      continue;
    }

    // Bullet list: consume consecutive bullet lines
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc list-outside ml-4 my-1 space-y-0.5">
          {items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="list-decimal list-outside ml-5 my-1 space-y-0.5">
          {items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
        </ol>
      );
      continue;
    }

    // Blank line
    if (trimmed === "") {
      blocks.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }

    // Paragraph
    blocks.push(<p key={key++} className="my-0.5">{renderInline(line)}</p>);
    i++;
  }
  return <>{blocks}</>;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) {
    const mins = Math.ceil(-ms / 60000);
    if (mins < 60) return `in ${mins}m`;
    return `in ${Math.round(mins / 60)}h`;
  }
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function AgentDebugPanel() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [config, setConfig] = useState<AgentConfig>({ intervalMs: 30000, systemPrompt: "", dreamPrompt: "", model: "claude-sonnet-4-6", tickModel: "claude-sonnet-4-6", dreamModel: "claude-sonnet-4-6", nextTickAt: null, running: false });
  const [countdown, setCountdown] = useState<string>("");
  const [promptDraft, setPromptDraft] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [dreamDraft, setDreamDraft] = useState("");
  const [dreamDirty, setDreamDirty] = useState(false);
  const [dreamSaving, setDreamSaving] = useState(false);
  const [dreamRunning, setDreamRunning] = useState(false);
  const [newMemory, setNewMemory] = useState("");
  const [newMemoryCategory, setNewMemoryCategory] = useState("general");
  const [showDeletedMemories, setShowDeletedMemories] = useState(false);
  const [memoryCategoryFilter, setMemoryCategoryFilter] = useState<string>("all");
  const [newCallbackReason, setNewCallbackReason] = useState("");
  const [newCallbackMinutes, setNewCallbackMinutes] = useState(5);
  const [intervalInput, setIntervalInput] = useState(30);

  const refresh = useCallback(async () => {
    const [memRes, cbRes, tcRes, cfgRes] = await Promise.all([
      fetch(`/api/agent/memories${showDeletedMemories ? "?includeDeleted=true" : ""}`),
      fetch("/api/agent/callbacks"),
      fetch("/api/agent/tool-calls?limit=30"),
      fetch("/api/agent/config"),
    ]);
    setMemories(await memRes.json());
    setCallbacks(await cbRes.json());
    setToolCalls(await tcRes.json());
    const cfg = await cfgRes.json();
    setConfig(cfg);
    setIntervalInput(Math.round(cfg.intervalMs / 1000));
    if (!promptDirty) {
      setPromptDraft(cfg.systemPrompt);
    }
    if (!dreamDirty) {
      setDreamDraft(cfg.dreamPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeletedMemories]);

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => {
      if (config.running) {
        setCountdown("Running...");
      } else if (config.nextTickAt) {
        const remaining = Math.max(0, Math.round((config.nextTickAt - Date.now()) / 1000));
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setCountdown(mins > 0 ? `${mins}m ${secs}s` : `${secs}s`);
      } else {
        setCountdown("—");
      }
    }, 1000);
    return () => clearInterval(id);
  }, [config.nextTickAt, config.running]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const addMemory = async () => {
    if (!newMemory.trim()) return;
    await fetch("/api/agent/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newMemory, category: newMemoryCategory }),
    });
    setNewMemory("");
    refresh();
  };

  const removeMemory = async (id: string) => {
    await fetch(`/api/agent/memories/${id}`, { method: "DELETE" });
    if (showDeletedMemories) {
      // Keep in list but mark deleted
      setMemories((prev) => prev.map((m) => m.id === id ? { ...m, deletedAt: new Date().toISOString() } : m));
    } else {
      setMemories((prev) => prev.filter((m) => m.id !== id));
    }
  };

  const restoreMemoryFn = async (id: string) => {
    await fetch(`/api/agent/memories/${id}/restore`, { method: "POST" });
    setMemories((prev) => prev.map((m) => m.id === id ? { ...m, deletedAt: null } : m));
  };

  const hardDeleteMemory = async (id: string) => {
    if (!confirm("Permanently delete this memory? This cannot be undone.")) return;
    await fetch(`/api/agent/memories/${id}?hard=true`, { method: "DELETE" });
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  const togglePinMemory = async (id: string, pinned: boolean) => {
    // Optimistic update
    setMemories((prev) => prev.map((m) => m.id === id ? { ...m, pinned } : m));
    await fetch(`/api/agent/memories/${id}/pin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
  };

  const addCallback = async () => {
    if (!newCallbackReason.trim()) return;
    await fetch("/api/agent/callbacks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: newCallbackReason, minutes: newCallbackMinutes }),
    });
    setNewCallbackReason("");
    refresh();
  };

  const removeCallback = async (id: string) => {
    await fetch(`/api/agent/callbacks/${id}`, { method: "DELETE" });
    setCallbacks((prev) => prev.filter((c) => c.id !== id));
  };

  const clearLog = async () => {
    await fetch("/api/agent/tool-calls", { method: "DELETE" });
    setToolCalls([]);
  };

  const updateInterval = async () => {
    await fetch("/api/agent/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intervalMs: intervalInput * 1000 }),
    });
    refresh();
  };

  const updateTickModel = async (tickModel: string) => {
    await fetch("/api/agent/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickModel }),
    });
    refresh();
  };

  const updateDreamModel = async (dreamModel: string) => {
    await fetch("/api/agent/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dreamModel }),
    });
    refresh();
  };

  const savePrompt = async () => {
    setPromptSaving(true);
    await fetch("/api/agent/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: promptDraft }),
    });
    setPromptDirty(false);
    setPromptSaving(false);
    refresh();
  };

  const saveDreamPrompt = async () => {
    setDreamSaving(true);
    await fetch("/api/agent/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dreamPrompt: dreamDraft }),
    });
    setDreamDirty(false);
    setDreamSaving(false);
    refresh();
  };

  const runDream = async () => {
    setDreamRunning(true);
    await fetch("/api/agent/dream", { method: "POST" });
    // Don't wait for completion — it runs in background
    setTimeout(() => { setDreamRunning(false); refresh(); }, 3000);
  };

  return (
    <section className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span>🤖</span> Agent Debug
      </h2>

      {/* System Prompt */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">System Prompt</h3>
          <div className="flex items-center gap-2">
            {promptDirty && (
              <span className="text-[10px] text-amber-400">Unsaved changes</span>
            )}
            <button
              onClick={savePrompt}
              disabled={!promptDirty || promptSaving}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
            >
              {promptSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
        <textarea
          value={promptDraft}
          onChange={(e) => { setPromptDraft(e.target.value); setPromptDirty(true); }}
          rows={6}
          placeholder="Enter system prompt for the AI agent..."
          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono resize-y"
        />
      </div>

      {/* Dream Mode Prompt */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            💤 Dream Mode Prompt
          </h3>
          <div className="flex items-center gap-2">
            {dreamDirty && (
              <span className="text-[10px] text-amber-400">Unsaved changes</span>
            )}
            <button
              onClick={saveDreamPrompt}
              disabled={!dreamDirty || dreamSaving}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
            >
              {dreamSaving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={runDream}
              disabled={dreamRunning || config.running}
              className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
            >
              {dreamRunning ? "💤 Dreaming..." : "Run Now"}
            </button>
          </div>
        </div>
        <textarea
          value={dreamDraft}
          onChange={(e) => { setDreamDraft(e.target.value); setDreamDirty(true); }}
          rows={4}
          placeholder="Enter dream mode prompt..."
          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono resize-y"
        />
        <p className="text-[10px] text-gray-500 mt-1">Runs daily at 3 AM. The agent reviews the day and saves reflections to memory.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:h-[480px]">
        {/* Config */}
        <div className="lg:col-span-3 bg-gray-800 rounded-xl p-4 border border-gray-700 overflow-y-auto">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Agent Config</h3>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Tick model</label>
              <select
                value={config.tickModel}
                onChange={(e) => updateTickModel(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-100"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-500 mt-1">Used for proactive check-ins and user chat.</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Dream model</label>
              <select
                value={config.dreamModel}
                onChange={(e) => updateDreamModel(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-100"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-500 mt-1">Used for daily dream reflection. Needs larger context.</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Idle interval</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={intervalInput}
                  onChange={(e) => setIntervalInput(Number(e.target.value))}
                  className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-gray-100"
                />
                <span className="text-xs text-gray-400">sec</span>
                <button
                  onClick={updateInterval}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                >
                  Set
                </button>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">Current: {config.intervalMs / 1000}s</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Next tick</label>
              <p className={`text-sm font-mono ${config.running ? "text-yellow-400" : "text-gray-200"}`}>
                {config.running ? "⚡ Running..." : `⏱ ${countdown}`}
              </p>
            </div>
          </div>
        </div>

        {/* Memories */}
        <div className="lg:col-span-5 bg-gray-800 rounded-xl p-4 border border-gray-700 flex flex-col min-h-0">
          {(() => {
            const categories = Array.from(new Set(memories.map((m) => m.category))).sort();
            const visible = memories.filter((m) =>
              memoryCategoryFilter === "all" || m.category === memoryCategoryFilter
            );
            const activeCount = visible.filter((m) => !m.deletedAt).length;
            const pinnedCount = visible.filter((m) => m.pinned && !m.deletedAt).length;
            const deletedCount = visible.filter((m) => m.deletedAt).length;
            return (
              <>
                <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                  <h3 className="text-sm font-medium text-gray-300">
                    Memories <span className="text-gray-500">
                      ({activeCount}
                      {pinnedCount > 0 ? `, ${pinnedCount} pinned` : ""}
                      {showDeletedMemories && deletedCount > 0 ? `, ${deletedCount} deleted` : ""})
                    </span>
                  </h3>
                  <div className="flex items-center gap-2">
                    <select
                      value={memoryCategoryFilter}
                      onChange={(e) => setMemoryCategoryFilter(e.target.value)}
                      className="text-[10px] bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-gray-300"
                    >
                      <option value="all">all categories</option>
                      {categories.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <label className="text-[10px] text-gray-500 hover:text-gray-300 cursor-pointer flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={showDeletedMemories}
                        onChange={(e) => setShowDeletedMemories(e.target.checked)}
                        className="accent-blue-500"
                      />
                      show deleted
                    </label>
                  </div>
                </div>
                <div className="space-y-2 flex-1 min-h-0 overflow-y-auto mb-3">
                  {visible.length === 0 && <p className="text-xs text-gray-500">No memories{memoryCategoryFilter !== "all" ? ` in "${memoryCategoryFilter}"` : " stored"}</p>}
                  {visible.map((m) => (
              <div key={m.id} className={`flex items-start justify-between gap-2 text-xs ${m.pinned && !m.deletedAt ? "bg-amber-500/5 -mx-2 px-2 py-1 rounded" : ""} ${m.deletedAt ? "opacity-50" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    {m.pinned && !m.deletedAt && <span className="text-amber-400 text-[10px]" title="Pinned">📌</span>}
                    <span className="text-[10px] bg-gray-700 text-gray-400 px-1 rounded">{m.category}</span>
                    {m.deletedAt && <span className="text-[10px] bg-red-900/60 text-red-300 px-1 rounded">deleted</span>}
                  </div>
                  <p className={`mt-0.5 ${m.deletedAt ? "text-gray-500 line-through" : "text-gray-300"}`}>{m.content}</p>
                  <p className="text-[10px] text-gray-600">
                    {timeAgo(m.createdAt)}
                    {m.deletedAt && ` · deleted ${timeAgo(m.deletedAt)}`}
                  </p>
                </div>
                <div className="flex items-start gap-1 flex-shrink-0">
                  {m.deletedAt ? (
                    <>
                      <button
                        onClick={() => restoreMemoryFn(m.id)}
                        className="text-gray-600 hover:text-green-400"
                        title="Restore"
                      >
                        ↺
                      </button>
                      <button
                        onClick={() => hardDeleteMemory(m.id)}
                        className="text-gray-600 hover:text-red-400"
                        title="Permanently delete"
                      >
                        🗑
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => togglePinMemory(m.id, !m.pinned)}
                        className={`${m.pinned ? "text-amber-400 hover:text-amber-300" : "text-gray-600 hover:text-amber-400"}`}
                        title={m.pinned ? "Unpin" : "Pin"}
                      >
                        📌
                      </button>
                      <button onClick={() => removeMemory(m.id)} className="text-gray-600 hover:text-red-400" title="Delete">✕</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
              </>
            );
          })()}
          <div className="flex gap-1">
            <input
              value={newMemory}
              onChange={(e) => setNewMemory(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addMemory()}
              placeholder="Add memory..."
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
            />
            <select
              value={newMemoryCategory}
              onChange={(e) => setNewMemoryCategory(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-1 py-1 text-xs text-gray-300"
            >
              <option value="general">general</option>
              <option value="preferences">preferences</option>
              <option value="facts">facts</option>
              <option value="tasks">tasks</option>
              <option value="people">people</option>
            </select>
            <button onClick={addMemory} className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">+</button>
          </div>
        </div>

        {/* Callbacks */}
        <div className="lg:col-span-4 bg-gray-800 rounded-xl p-4 border border-gray-700 flex flex-col min-h-0">
          <h3 className="text-sm font-medium text-gray-300 mb-3">
            Scheduled Callbacks <span className="text-gray-500">({callbacks.filter((c) => !c.fired).length} pending)</span>
          </h3>
          <div className="space-y-2 flex-1 min-h-0 overflow-y-auto mb-3">
            {callbacks.length === 0 && <p className="text-xs text-gray-500">No callbacks scheduled</p>}
            {callbacks.map((cb) => (
              <div key={cb.id} className={`flex items-start justify-between gap-2 text-xs ${cb.fired ? "opacity-50" : ""}`}>
                <div className="min-w-0">
                  <p className="text-gray-300">{cb.reason}</p>
                  <p className="text-[10px] text-gray-500">
                    {cb.fired ? "Fired" : timeAgo(cb.fireAt)}
                  </p>
                </div>
                <button onClick={() => removeCallback(cb.id)} className="text-gray-600 hover:text-red-400 flex-shrink-0">✕</button>
              </div>
            ))}
          </div>
          <div className="flex gap-1">
            <input
              value={newCallbackReason}
              onChange={(e) => setNewCallbackReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCallback()}
              placeholder="Reason..."
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
            />
            <input
              type="number"
              min={1}
              value={newCallbackMinutes}
              onChange={(e) => setNewCallbackMinutes(Number(e.target.value))}
              className="w-14 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
            />
            <span className="text-xs text-gray-400 self-center">min</span>
            <button onClick={addCallback} className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded">+</button>
          </div>
        </div>
      </div>

      {/* Tool Call Log */}
      <div className="mt-4 bg-gray-800 rounded-xl p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-300">
            Tool Call Log <span className="text-gray-500">({toolCalls.length})</span>
          </h3>
          <button onClick={clearLog} className="text-[10px] text-gray-500 hover:text-red-400 transition-colors">
            Clear
          </button>
        </div>
        <div className="space-y-1.5 max-h-96 overflow-y-auto font-mono text-[11px]">
          {toolCalls.length === 0 && <p className="text-xs text-gray-500 font-sans">No tool calls logged</p>}
          {toolCalls.map((tc) => {
            const isAgentTick = tc.toolName === "[agent_tick]";
            const isCallback = tc.toolName === "[callback_fired]";
            const isDreamText = tc.toolName === "[dream_text]";
            const isDreamMeta = tc.toolName === "[dream_mode]" || tc.toolName === "[dream_result]" || tc.toolName === "[dream_error]";
            const isSystem = isAgentTick || isCallback;
            const args = tc.arguments as Record<string, unknown>;

            return (
              <div key={tc.id} className={`${isSystem ? "opacity-60" : ""}`}>
                <div className="flex gap-2 items-baseline">
                  <span className="text-gray-600 flex-shrink-0 w-14">{new Date(tc.calledAt).toLocaleTimeString()}</span>
                  <span className={`flex-shrink-0 ${
                    isAgentTick ? "text-yellow-500" :
                    isCallback ? "text-orange-400" :
                    isDreamText ? "text-purple-400" :
                    isDreamMeta ? "text-purple-500" :
                    "text-blue-400"
                  }`}>
                    {isAgentTick ? `⚡ tick #${args.tickCount} (${args.trigger})` :
                     isCallback ? `🔔 callback` :
                     isDreamText ? `💭 dream` :
                     tc.toolName}
                  </span>
                </div>
                {isDreamText ? (
                  <div className="ml-16 mt-1 mb-2 text-gray-200 font-sans text-xs leading-relaxed border-l-2 border-purple-800/50 pl-3">
                    {renderMarkdown(String(args.text ?? ""))}
                  </div>
                ) : !isAgentTick && (
                  <div className="ml-16 text-gray-500 break-all whitespace-pre-wrap">
                    {JSON.stringify(tc.arguments, null, 2)}
                  </div>
                )}
                {tc.result && !isSystem && !isDreamText && (
                  <div className="ml-16 text-emerald-600 break-all whitespace-pre-wrap">→ {tc.result}</div>
                )}
                {isCallback && (
                  <div className="ml-16 text-gray-500">{args.reason as string}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
