import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getTasks, getTask, addTask, updateTask, deleteTask, type TaskStatus } from "../db.js";
import { broadcastEvent } from "../ws.js";
import { log } from "../logger.js";

const tasks = new Hono();

tasks.get("/api/tasks", (c) => {
  const status = c.req.query("status") as TaskStatus | undefined;
  return c.json(getTasks(status));
});

tasks.get("/api/tasks/:id", (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "Task not found" }, 404);
  return c.json(task);
});

tasks.post("/api/tasks", async (c) => {
  const body = await c.req.json<{ title: string; description?: string; status?: TaskStatus }>();
  log("[routes] POST /api/tasks", JSON.stringify(body));
  if (!body.title?.trim()) return c.json({ error: "title required" }, 400);
  const task = addTask(randomUUID(), body.title.trim(), body.description, body.status);
  broadcastEvent({ event: "task_updated", task: task as unknown as Record<string, unknown> });
  return c.json(task, 201);
});

tasks.put("/api/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string; description?: string | null; status?: TaskStatus; sortOrder?: number }>();
  log(`[routes] PUT /api/tasks/${id}`, JSON.stringify(body));
  const task = updateTask(id, body);
  if (!task) return c.json({ error: "Task not found" }, 404);
  broadcastEvent({ event: "task_updated", task: task as unknown as Record<string, unknown> });
  return c.json(task);
});

tasks.delete("/api/tasks/:id", (c) => {
  const id = c.req.param("id");
  log(`[routes] DELETE /api/tasks/${id}`);
  const ok = deleteTask(id);
  if (!ok) return c.json({ error: "Task not found" }, 404);
  broadcastEvent({ event: "task_deleted", id });
  return c.json({ ok: true });
});

export default tasks;
