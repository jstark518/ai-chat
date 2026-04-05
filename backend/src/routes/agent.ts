import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  getMemories, addMemory, deleteMemory, restoreMemory, hardDeleteMemory, setMemoryPinned,
  getAllCallbacks, addScheduledCallback, deleteCallback,
  getToolCalls, clearToolCalls,
  getSetting, setSetting,
} from "../db.js";
import { log } from "../logger.js";
import { setProactiveInterval, DEFAULT_SYSTEM_PROMPT, DEFAULT_DREAM_PROMPT, getNextTickAt, isAgentRunning, triggerDream } from "../agent.js";

const agent = new Hono();

// --- Memories ---

agent.get("/api/agent/memories", (c) => {
  const category = c.req.query("category");
  const includeDeleted = c.req.query("includeDeleted") === "true";
  return c.json(getMemories(category, includeDeleted));
});

agent.post("/api/agent/memories", async (c) => {
  const body = await c.req.json<{ content: string; category?: string }>();
  log("[routes] POST /api/agent/memories", JSON.stringify(body));
  const memory = addMemory(randomUUID(), body.content, body.category ?? "general");
  return c.json(memory, 201);
});

agent.delete("/api/agent/memories/:id", (c) => {
  const id = c.req.param("id");
  const hard = c.req.query("hard") === "true";
  log(`[routes] DELETE /api/agent/memories/${id}${hard ? " (hard)" : ""}`);
  const ok = hard ? hardDeleteMemory(id) : deleteMemory(id);
  if (!ok) return c.json({ error: "Memory not found" }, 404);
  return c.json({ ok: true });
});

agent.post("/api/agent/memories/:id/restore", (c) => {
  const id = c.req.param("id");
  log(`[routes] POST /api/agent/memories/${id}/restore`);
  const ok = restoreMemory(id);
  if (!ok) return c.json({ error: "Memory not found" }, 404);
  return c.json({ ok: true });
});

agent.put("/api/agent/memories/:id/pin", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ pinned: boolean }>();
  log(`[routes] PUT /api/agent/memories/${id}/pin`, JSON.stringify(body));
  const ok = setMemoryPinned(id, body.pinned);
  if (!ok) return c.json({ error: "Memory not found" }, 404);
  return c.json({ ok: true, pinned: body.pinned });
});

// --- Callbacks ---

agent.get("/api/agent/callbacks", (c) => {
  return c.json(getAllCallbacks());
});

agent.post("/api/agent/callbacks", async (c) => {
  const body = await c.req.json<{ reason: string; minutes: number }>();
  log("[routes] POST /api/agent/callbacks", JSON.stringify(body));
  const fireAt = new Date(Date.now() + body.minutes * 60 * 1000).toISOString();
  const cb = addScheduledCallback(randomUUID(), body.reason, fireAt);
  return c.json(cb, 201);
});

agent.delete("/api/agent/callbacks/:id", (c) => {
  const id = c.req.param("id");
  log(`[routes] DELETE /api/agent/callbacks/${id}`);
  const deleted = deleteCallback(id);
  if (!deleted) return c.json({ error: "Callback not found" }, 404);
  return c.json({ ok: true });
});

// --- Tool Call Log ---

agent.get("/api/agent/tool-calls", (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json(getToolCalls(limit));
});

agent.delete("/api/agent/tool-calls", (c) => {
  log("[routes] DELETE /api/agent/tool-calls");
  clearToolCalls();
  return c.json({ ok: true });
});

// --- Agent Config ---

agent.get("/api/agent/config", (c) => {
  const intervalMs = Number(getSetting("agent_interval_ms") ?? 30000);
  const systemPrompt = getSetting("system_prompt") ?? DEFAULT_SYSTEM_PROMPT;
  const dreamPrompt = getSetting("dream_prompt") ?? DEFAULT_DREAM_PROMPT;
  const legacyModel = getSetting("agent_model") ?? "claude-sonnet-4-6";
  const tickModel = getSetting("tick_model") ?? legacyModel;
  const dreamModel = getSetting("dream_model") ?? legacyModel;
  const nextTickAt = getNextTickAt();
  const running = isAgentRunning();
  // `model` is kept for back-compat with older clients
  return c.json({ intervalMs, systemPrompt, dreamPrompt, model: tickModel, tickModel, dreamModel, nextTickAt, running });
});

agent.put("/api/agent/config", async (c) => {
  const body = await c.req.json<{
    intervalMs?: number;
    systemPrompt?: string;
    dreamPrompt?: string;
    model?: string;
    tickModel?: string;
    dreamModel?: string;
  }>();
  log("[routes] PUT /api/agent/config", JSON.stringify({ ...body, systemPrompt: body.systemPrompt ? `(${body.systemPrompt.length} chars)` : undefined, dreamPrompt: body.dreamPrompt ? `(${body.dreamPrompt.length} chars)` : undefined }));
  if (body.intervalMs !== undefined) {
    setSetting("agent_interval_ms", String(body.intervalMs));
    setProactiveInterval(body.intervalMs);
  }
  if (body.systemPrompt !== undefined) {
    setSetting("system_prompt", body.systemPrompt);
  }
  if (body.dreamPrompt !== undefined) {
    setSetting("dream_prompt", body.dreamPrompt);
  }
  // New: per-prompt-type models
  if (body.tickModel !== undefined) {
    setSetting("tick_model", body.tickModel);
  }
  if (body.dreamModel !== undefined) {
    setSetting("dream_model", body.dreamModel);
  }
  // Legacy: `model` sets the tick model (back-compat)
  if (body.model !== undefined) {
    setSetting("tick_model", body.model);
    setSetting("agent_model", body.model); // keep legacy key in sync
  }
  return c.json({ ok: true });
});

// --- Dream Mode ---

agent.post("/api/agent/dream", async (c) => {
  log("[routes] POST /api/agent/dream — triggering dream mode");
  if (!triggerDream) {
    return c.json({ error: "Agent not initialized" }, 500);
  }
  // Run in background so the request doesn't hang
  triggerDream().catch((err) => log(`[routes] Dream mode error: ${err}`));
  return c.json({ ok: true, message: "Dream mode started" });
});

export default agent;
