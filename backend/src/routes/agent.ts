import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  getMemories, addMemory, deleteMemory, restoreMemory, hardDeleteMemory, setMemoryPinned,
  getAllCallbacks, addScheduledCallback, deleteCallback,
  getToolCalls, clearToolCalls,
  getSetting, setSetting,
} from "../db.js";
import { log } from "../logger.js";
import { setProactiveInterval, DEFAULT_REPLY_PROMPT, DEFAULT_PROACTIVE_PROMPT, DEFAULT_DREAM_PROMPT, DEFAULT_CODE_PROMPT, getNextTickAt, isAgentRunning, triggerDream, triggerProactive, triggerCodeAgent } from "../agent.js";

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
  const legacyModel = getSetting("agent_model") ?? "claude-sonnet-4-6";
  // Per-type prompts with fallback to legacy system_prompt
  const replyPrompt = getSetting("reply_prompt") ?? getSetting("system_prompt") ?? DEFAULT_REPLY_PROMPT;
  const proactivePrompt = getSetting("proactive_prompt") ?? getSetting("system_prompt") ?? DEFAULT_PROACTIVE_PROMPT;
  const dreamPrompt = getSetting("dream_prompt") ?? DEFAULT_DREAM_PROMPT;
  const codePrompt = getSetting("code_prompt") ?? DEFAULT_CODE_PROMPT;
  // Per-type models with fallback to legacy tick_model → agent_model
  const replyModel = getSetting("reply_model") ?? getSetting("tick_model") ?? legacyModel;
  const proactiveModel = getSetting("proactive_model") ?? getSetting("tick_model") ?? legacyModel;
  const dreamModel = getSetting("dream_model") ?? legacyModel;
  const codeModel = getSetting("code_model") ?? legacyModel;
  const nextTickAt = getNextTickAt();
  const running = isAgentRunning();
  return c.json({
    intervalMs, replyPrompt, proactivePrompt, dreamPrompt, codePrompt,
    replyModel, proactiveModel, dreamModel, codeModel,
    // Back-compat aliases
    systemPrompt: replyPrompt, model: replyModel, tickModel: replyModel,
    nextTickAt, running,
  });
});

agent.put("/api/agent/config", async (c) => {
  const body = await c.req.json<{
    intervalMs?: number;
    replyPrompt?: string;
    proactivePrompt?: string;
    dreamPrompt?: string;
    codePrompt?: string;
    replyModel?: string;
    proactiveModel?: string;
    dreamModel?: string;
    codeModel?: string;
    // Back-compat
    systemPrompt?: string;
    model?: string;
    tickModel?: string;
  }>();
  log("[routes] PUT /api/agent/config", JSON.stringify({
    ...body,
    replyPrompt: body.replyPrompt ? `(${body.replyPrompt.length} chars)` : undefined,
    proactivePrompt: body.proactivePrompt ? `(${body.proactivePrompt.length} chars)` : undefined,
    dreamPrompt: body.dreamPrompt ? `(${body.dreamPrompt.length} chars)` : undefined,
    codePrompt: (body as Record<string,unknown>).codePrompt ? `(${((body as Record<string,unknown>).codePrompt as string).length} chars)` : undefined,
    systemPrompt: body.systemPrompt ? `(${body.systemPrompt.length} chars)` : undefined,
  }));
  if (body.intervalMs !== undefined) {
    setSetting("agent_interval_ms", String(body.intervalMs));
    setProactiveInterval(body.intervalMs);
  }
  // Per-type prompts
  if (body.replyPrompt !== undefined) setSetting("reply_prompt", body.replyPrompt);
  if (body.proactivePrompt !== undefined) setSetting("proactive_prompt", body.proactivePrompt);
  if (body.dreamPrompt !== undefined) setSetting("dream_prompt", body.dreamPrompt);
  if (body.codePrompt !== undefined) setSetting("code_prompt", body.codePrompt);
  // Per-type models
  if (body.replyModel !== undefined) setSetting("reply_model", body.replyModel);
  if (body.proactiveModel !== undefined) setSetting("proactive_model", body.proactiveModel);
  if (body.dreamModel !== undefined) setSetting("dream_model", body.dreamModel);
  if (body.codeModel !== undefined) setSetting("code_model", body.codeModel);
  // Back-compat: systemPrompt → reply_prompt
  if (body.systemPrompt !== undefined) {
    setSetting("system_prompt", body.systemPrompt);
    setSetting("reply_prompt", body.systemPrompt);
  }
  // Back-compat: tickModel → reply + proactive
  if (body.tickModel !== undefined) {
    setSetting("tick_model", body.tickModel);
    setSetting("reply_model", body.tickModel);
    setSetting("proactive_model", body.tickModel);
  }
  // Back-compat: model → same as tickModel
  if (body.model !== undefined) {
    setSetting("agent_model", body.model);
    setSetting("tick_model", body.model);
    setSetting("reply_model", body.model);
    setSetting("proactive_model", body.model);
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
  triggerDream(true).catch((err) => log(`[routes] Dream mode error: ${err}`));
  return c.json({ ok: true, message: "Dream mode started" });
});

// --- Manual Proactive Run ---

agent.post("/api/agent/proactive", (c) => {
  log("[routes] POST /api/agent/proactive — triggering proactive run");
  if (!triggerProactive) {
    return c.json({ error: "Agent not initialized" }, 500);
  }
  triggerProactive();
  return c.json({ ok: true, message: "Proactive run triggered" });
});

// --- Manual Code Review ---

agent.post("/api/agent/code-review", (c) => {
  log("[routes] POST /api/agent/code-review — triggering code review");
  if (!triggerCodeAgent) {
    return c.json({ error: "Agent not initialized" }, 500);
  }
  triggerCodeAgent(true).catch((err) => log(`[routes] Code review error: ${err}`));
  return c.json({ ok: true, message: "Code review started" });
});

export default agent;
