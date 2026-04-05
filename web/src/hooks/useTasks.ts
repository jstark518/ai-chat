import { useCallback, useEffect, useRef, useState } from "react";

export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (res.ok) setTasks(await res.json());
    } catch { /* ignore */ }
  }, []);

  const connect = useCallback(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onclose = () => {
      reconnectRef.current = setTimeout(connect, 2000);
    };
    ws.onmessage = (e) => {
      let data: unknown;
      try { data = JSON.parse(e.data); } catch { return; }
      if (typeof data !== "object" || data === null || !("event" in data)) return;
      const evt = data as { event: string };
      if (evt.event === "task_updated") {
        const task = (data as { task: Task }).task;
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === task.id);
          if (idx === -1) return [...prev, task];
          const next = [...prev];
          next[idx] = task;
          return next;
        });
      } else if (evt.event === "task_deleted") {
        const id = (data as { id: string }).id;
        setTasks((prev) => prev.filter((t) => t.id !== id));
      }
    };
  }, []);

  useEffect(() => {
    load();
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [load, connect]);

  const addTask = useCallback(async (title: string, status: TaskStatus = "todo") => {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, status }),
    });
    if (res.ok) {
      const task = await res.json() as Task;
      setTasks((prev) => prev.some((t) => t.id === task.id) ? prev : [...prev, task]);
    }
  }, []);

  const updateTask = useCallback(async (id: string, data: Partial<Pick<Task, "title" | "description" | "status" | "sortOrder">>) => {
    // Optimistic update
    setTasks((prev) => prev.map((t) => t.id === id ? { ...t, ...data } : t));
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }, []);

  const deleteTask = useCallback(async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
  }, []);

  return { tasks, addTask, updateTask, deleteTask };
}
