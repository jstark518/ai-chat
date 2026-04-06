import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  insertMessage, getMessages, getLocation,
  addMemory, getMemories, deleteMemory, updateMemory, searchMemories, setMemoryPinned,
  addScheduledCallback, getAllCallbacks, deleteCallback,
  getTasks, addTask, updateTask, deleteTask, type TaskStatus,
  getSetting, setSetting, getDreams,
} from "./db.js";
import type { Message } from "./db.js";
import { broadcast, broadcastEvent } from "./ws.js";
import { log } from "./logger.js";
import { registerSmartHomeTools } from "./smarthome.js";
import { DEFAULT_REPLY_PROMPT, DEFAULT_PROACTIVE_PROMPT, DEFAULT_DREAM_PROMPT } from "./agent.js";
import { registerWebTools } from "./web-tools.js";

/** Simple line-based diff for logging minor memory edits. */
function lineDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Strip common prefix/suffix to isolate just the changed region
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const lines: string[] = [];
  // Show 1 line of leading context
  if (start > 0) lines.push(`  ${oldLines[start - 1]}`);
  for (let i = start; i < endOld; i++) lines.push(`- ${oldLines[i]}`);
  for (let i = start; i < endNew; i++) lines.push(`+ ${newLines[i]}`);
  // Show 1 line of trailing context
  if (endOld < oldLines.length) lines.push(`  ${oldLines[endOld]}`);

  if (lines.length === 0) return "(no changes)";
  return lines.join("\n");
}

// --- Pending user response tracking ---
// When ask_question or ask_multiple_choice is called, we store a resolver here.
// When the user sends a message, we resolve the pending promise.

interface PendingResponse {
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingResponses = new Map<string, PendingResponse>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Called when a user message arrives. If there's a pending tool waiting
 * for a response, resolve it with the user's message.
 */
export function resolveUserResponse(content: string): boolean {
  // Resolve the most recent pending response (there should only be one)
  for (const [messageId, pending] of pendingResponses) {
    log(`[mcp] Resolving pending response for message ${messageId}: "${content}"`);
    clearTimeout(pending.timer);
    pending.resolve(content);
    pendingResponses.delete(messageId);
    return true;
  }
  return false;
}

/** Returns true if a tool is currently waiting for a user response. */
export function hasPendingResponse(): boolean {
  return pendingResponses.size > 0;
}

function waitForUserResponse(messageId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, _reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(messageId);
      log(`[mcp] Response timeout for message ${messageId}`);
      resolve("[No response — timed out]");
    }, timeoutMs);

    pendingResponses.set(messageId, { resolve, timer });
  });
}

// --- Pending location requests (iOS fetches fresh location on demand) ---
interface PendingLocation {
  resolve: (loc: { latitude: number; longitude: number } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingLocations = new Map<string, PendingLocation>();

/** Called when iOS sends back location in response to a request_location event. */
export function resolveLocationRequest(requestId: string, latitude: number, longitude: number): boolean {
  const pending = pendingLocations.get(requestId);
  if (!pending) return false;
  log(`[mcp] Resolving location request ${requestId}: ${latitude}, ${longitude}`);
  clearTimeout(pending.timer);
  pending.resolve({ latitude, longitude });
  pendingLocations.delete(requestId);
  return true;
}

function waitForLocation(requestId: string, timeoutMs = 10_000): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingLocations.delete(requestId);
      log(`[mcp] Location request timeout for ${requestId}`);
      resolve(null);
    }, timeoutMs);
    pendingLocations.set(requestId, { resolve, timer });
  });
}

function createMCPServer(): McpServer {
  const server = new McpServer({
    name: "ai-assistant",
    version: "1.0.0",
  });

  // --- ask_question ---
  server.tool(
    "ask_question",
    "Ask the user a free-form question. Blocks until the user responds or times out. Returns the user's answer.",
    { question: z.string().describe("The question to ask the user") },
    async ({ question }) => {
      log("[mcp] Tool called: ask_question", JSON.stringify({ question }));
      const messageId = randomUUID();
      const message: Message = {
        id: messageId,
        role: "assistant",
        content: question,
        type: "question",
        timestamp: new Date().toISOString(),
      };
      insertMessage(message);
      broadcastEvent({ event: "typing", typing: false });
      broadcast(message);

      log(`[mcp] Waiting for user response to question ${messageId}...`);
      const answer = await waitForUserResponse(messageId);
      log(`[mcp] User answered question: "${answer}"`);

      return {
        content: [{ type: "text" as const, text: answer }],
      };
    }
  );

  // --- ask_multiple_choice ---
  server.tool(
    "ask_multiple_choice",
    "Ask the user a multiple choice question. Blocks until the user selects an option or times out. Returns the selected option.",
    {
      question: z.string().describe("The question to ask"),
      options: z.array(z.string()).min(2).describe("The available options to choose from"),
    },
    async ({ question, options }) => {
      log("[mcp] Tool called: ask_multiple_choice", JSON.stringify({ question, options }));
      const messageId = randomUUID();
      const message: Message = {
        id: messageId,
        role: "assistant",
        content: question,
        type: "multiple_choice",
        options,
        timestamp: new Date().toISOString(),
      };
      insertMessage(message);
      broadcastEvent({ event: "typing", typing: false });
      broadcast(message);

      log(`[mcp] Waiting for user response to multiple choice ${messageId}...`);
      const answer = await waitForUserResponse(messageId);
      log(`[mcp] User selected: "${answer}"`);

      return {
        content: [{ type: "text" as const, text: answer }],
      };
    }
  );

  // --- send_message ---
  server.tool(
    "send_message",
    "Send a text message to the user. Use this to communicate information, acknowledge answers, or respond to the user.",
    { content: z.string().describe("The message text to send") },
    async ({ content }) => {
      log("[mcp] Tool called: send_message", JSON.stringify({ content }));
      const message: Message = {
        id: randomUUID(),
        role: "assistant",
        content,
        type: "text",
        timestamp: new Date().toISOString(),
      };
      insertMessage(message);
      broadcastEvent({ event: "typing", typing: false });
      broadcast(message);
      return {
        content: [{ type: "text" as const, text: `Message sent: "${content.slice(0, 80)}"` }],
      };
    }
  );

  // --- get_current_time ---
  server.tool(
    "get_current_time",
    "Get the current date, time, day of week, and timezone.",
    {},
    async () => {
      const now = new Date();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            iso: now.toISOString(),
            local: now.toLocaleString(),
            date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
            time: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            unix: Math.floor(now.getTime() / 1000),
          }),
        }],
      };
    }
  );

  // --- get_location ---
  server.tool(
    "get_location",
    "Get the user's current location (latitude and longitude) from their device. Requests fresh location from the iOS app.",
    {},
    async () => {
      log("[mcp] Tool called: get_location");

      // Request fresh location from iOS via WebSocket
      const requestId = randomUUID();
      broadcastEvent({ event: "request_location", requestId });

      // Wait for iOS to respond (10s timeout)
      const fresh = await waitForLocation(requestId);

      if (fresh) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              latitude: fresh.latitude,
              longitude: fresh.longitude,
              source: "fresh",
            }),
          }],
        };
      }

      // Fall back to last known location from DB
      const cached = getLocation();
      if (cached) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              latitude: cached.latitude,
              longitude: cached.longitude,
              updated_at: cached.updated_at,
              source: "cached",
              note: "iOS app didn't respond in time — returning last known location",
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: "No location data available. The iOS app may not have location permissions or isn't connected.",
        }],
      };
    }
  );

  // --- get_messages ---
  server.tool(
    "get_messages",
    "Get recent message history from the conversation. Timestamps are in both UTC (iso) and local time (localTime) for convenience.",
    {
      limit: z.number().optional().default(20).describe("Maximum number of messages to return"),
    },
    async ({ limit }) => {
      log("[mcp] Tool called: get_messages", JSON.stringify({ limit }));
      const messages = getMessages(limit).map((m) => ({
        ...m,
        localTime: new Date(m.timestamp).toLocaleString("en-US", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(messages) }],
      };
    }
  );

  // --- set_reminder ---
  server.tool(
    "set_reminder",
    "Set a reminder that will send a message to the user after a specified number of minutes.",
    {
      message: z.string().describe("The reminder message to send"),
      minutes: z.number().min(1).max(1440).describe("Minutes from now to send the reminder"),
    },
    async ({ message: reminderText, minutes }) => {
      log("[mcp] Tool called: set_reminder", JSON.stringify({ message: reminderText, minutes }));
      const ms = minutes * 60 * 1000;
      setTimeout(() => {
        log(`[mcp] Reminder firing: "${reminderText}"`);
        const message: Message = {
          id: randomUUID(),
          role: "assistant",
          content: `⏰ Reminder: ${reminderText}`,
          type: "text",
          timestamp: new Date().toISOString(),
        };
        insertMessage(message);
        broadcast(message);
      }, ms);
      return {
        content: [
          {
            type: "text" as const,
            text: `Reminder set: "${reminderText}" in ${minutes} minute(s)`,
          },
        ],
      };
    }
  );

  // --- remember ---
  server.tool(
    "remember",
    "Save a piece of information to long-term memory. Use this to remember user preferences, facts, or anything the agent should recall later. Memories persist across restarts.",
    {
      content: z.string().describe("The information to remember"),
      category: z.string().optional().default("general").describe("Category for organizing memories (e.g. 'preferences', 'facts', 'tasks', 'people')"),
    },
    async ({ content, category }) => {
      log("[mcp] Tool called: remember", JSON.stringify({ content, category }));
      addMemory(randomUUID(), content, category);
      return {
        content: [{ type: "text" as const, text: `Remembered (${category}): "${content.slice(0, 100)}"` }],
      };
    }
  );

  // --- recall ---
  server.tool(
    "recall",
    "Search long-term memory for previously stored information. Returns all memories matching the query, or all memories in a category.",
    {
      query: z.string().optional().describe("Search text to find in memories"),
      category: z.string().optional().describe("Filter by category"),
    },
    async ({ query, category }) => {
      log("[mcp] Tool called: recall", JSON.stringify({ query, category }));
      let memories;
      if (query) {
        memories = searchMemories(query);
      } else {
        memories = getMemories(category);
      }
      return {
        content: [{ type: "text" as const, text: memories.length > 0 ? JSON.stringify(memories) : "No memories found" }],
      };
    }
  );

  // --- forget ---
  server.tool(
    "forget",
    "Delete a specific memory by ID.",
    {
      id: z.string().describe("The memory ID to delete"),
    },
    async ({ id }) => {
      log("[mcp] Tool called: forget", JSON.stringify({ id }));
      const deleted = deleteMemory(id);
      return {
        content: [{ type: "text" as const, text: deleted ? `Memory ${id} deleted` : `Memory ${id} not found` }],
      };
    }
  );

  // --- edit_memory ---
  server.tool(
    "edit_memory",
    "Update an existing memory's content in-place. IMPORTANT: Use this ONLY for minor edits — updating a date, fixing a typo, small clarifications, correcting a fact. For larger changes (new information, restructuring, merging multiple memories), use forget + remember instead so the full history is preserved.",
    {
      id: z.string().describe("The memory ID to edit"),
      content: z.string().describe("The new content. Should be a minor revision of the existing memory, not a rewrite."),
    },
    async ({ id, content }) => {
      log("[mcp] Tool called: edit_memory", JSON.stringify({ id, contentLength: content.length }));

      // Look up old content BEFORE updating so we can diff
      const existing = getMemories(undefined, true).find((m) => m.id === id);
      const oldContent = existing?.content ?? null;

      const updated = updateMemory(id, content);

      if (updated && oldContent !== null) {
        const diff = lineDiff(oldContent, content);
        log(`[mcp] edit_memory diff for ${id}:\n${diff}`);
      }

      return {
        content: [{ type: "text" as const, text: updated ? `Memory ${id} updated` : `Memory ${id} not found or deleted` }],
      };
    }
  );

  // --- pin_memory ---
  server.tool(
    "pin_memory",
    "Pin a memory so it's always included in the prompt context on every conversation. Use for critical facts about the user that should always be accessible (e.g. name, timezone, key preferences).",
    {
      id: z.string().describe("The memory ID to pin"),
    },
    async ({ id }) => {
      log("[mcp] Tool called: pin_memory", JSON.stringify({ id }));
      const ok = setMemoryPinned(id, true);
      return {
        content: [{ type: "text" as const, text: ok ? `Memory ${id} pinned` : `Memory ${id} not found` }],
      };
    }
  );

  // --- unpin_memory ---
  server.tool(
    "unpin_memory",
    "Unpin a memory so it's no longer automatically included in every prompt.",
    {
      id: z.string().describe("The memory ID to unpin"),
    },
    async ({ id }) => {
      log("[mcp] Tool called: unpin_memory", JSON.stringify({ id }));
      const ok = setMemoryPinned(id, false);
      return {
        content: [{ type: "text" as const, text: ok ? `Memory ${id} unpinned` : `Memory ${id} not found` }],
      };
    }
  );

  // --- schedule_callback ---
  server.tool(
    "schedule_callback",
    "Schedule the agent to wake up at a specific time with a reason. When the callback fires, the agent will run a tick with the reason as context. Use this for follow-ups, check-ins, or delayed actions.",
    {
      reason: z.string().describe("Why the agent should wake up — this will be provided as context when the callback fires"),
      minutes: z.number().min(1).max(10080).describe("Minutes from now to fire the callback (max 7 days)"),
    },
    async ({ reason, minutes }) => {
      log("[mcp] Tool called: schedule_callback", JSON.stringify({ reason, minutes }));
      const fireAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      addScheduledCallback(randomUUID(), reason, fireAt);
      return {
        content: [{ type: "text" as const, text: `Callback scheduled: "${reason}" in ${minutes} minute(s) (fires at ${fireAt})` }],
      };
    }
  );

  // --- list_callbacks ---
  server.tool(
    "list_callbacks",
    "List all scheduled callbacks (pending and fired).",
    {},
    async () => {
      log("[mcp] Tool called: list_callbacks");
      const callbacks = getAllCallbacks();
      return {
        content: [{ type: "text" as const, text: callbacks.length > 0 ? JSON.stringify(callbacks) : "No callbacks scheduled" }],
      };
    }
  );

  // --- cancel_callback ---
  server.tool(
    "cancel_callback",
    "Cancel a scheduled callback by ID.",
    {
      id: z.string().describe("The callback ID to cancel"),
    },
    async ({ id }) => {
      log("[mcp] Tool called: cancel_callback", JSON.stringify({ id }));
      const deleted = deleteCallback(id);
      return {
        content: [{ type: "text" as const, text: deleted ? `Callback ${id} cancelled` : `Callback ${id} not found` }],
      };
    }
  );

  // --- get_prompts ---
  server.tool(
    "get_prompts",
    "Read the current reply prompt (used when responding to user messages), proactive prompt (used for periodic check-ins), and dream prompt (used for nightly reflection). Use this before making edits with update_prompt so you can see what's there.",
    {},
    async () => {
      log("[mcp] Tool called: get_prompts");
      const replyPrompt = getSetting("reply_prompt") ?? getSetting("system_prompt") ?? DEFAULT_REPLY_PROMPT;
      const proactivePrompt = getSetting("proactive_prompt") ?? getSetting("system_prompt") ?? DEFAULT_PROACTIVE_PROMPT;
      const dreamPrompt = getSetting("dream_prompt") ?? DEFAULT_DREAM_PROMPT;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ replyPrompt, proactivePrompt, dreamPrompt }) }],
      };
    }
  );

  // --- update_prompt ---
  server.tool(
    "update_prompt",
    "Update a prompt. Three types: 'reply' (responds to user messages), 'proactive' (periodic check-ins), 'dream' (nightly reflection). IMPORTANT: These changes are persistent and affect all future agent runs. Be conservative — make small, targeted edits based on clear evidence from conversations. Don't rewrite the whole prompt; add or adjust specific rules or instructions. Prefer appending a new guideline over restructuring existing ones.",
    {
      type: z.enum(["reply", "proactive", "dream"]).describe("Which prompt to update"),
      content: z.string().describe("The full updated prompt text"),
    },
    async ({ type, content }) => {
      const keyMap: Record<string, string> = { reply: "reply_prompt", proactive: "proactive_prompt", dream: "dream_prompt" };
      const key = keyMap[type];
      log(`[mcp] Tool called: update_prompt (${type})`, `${content.length} chars`);
      setSetting(key, content);
      return {
        content: [{ type: "text" as const, text: `${type} prompt updated (${content.length} chars)` }],
      };
    }
  );

  // --- get_dream_history ---
  server.tool(
    "get_dream_history",
    "Read past dream reflections. Returns the most recent dream summaries including what memories were changed, patterns noticed, and self-improvement notes. Use this to review what previous dream sessions concluded.",
    {
      limit: z.number().min(1).max(50).optional().describe("Number of recent dreams to return (default 5)"),
    },
    async ({ limit }) => {
      log("[mcp] Tool called: get_dream_history", JSON.stringify({ limit }));
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const dreams = getDreams(limit ?? 5).map((d) => ({
        ...d,
        localStartedAt: new Date(d.startedAt).toLocaleString("en-US", { timeZone: tz }),
        localCompletedAt: new Date(d.completedAt).toLocaleString("en-US", { timeZone: tz }),
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(dreams) }] };
    }
  );

  // --- list_tasks ---
  server.tool(
    "list_tasks",
    "List the user's kanban tasks. Columns are: todo, doing, done. Optionally filter by status.",
    {
      status: z.enum(["todo", "doing", "done"]).optional().describe("Filter by column"),
    },
    async ({ status }) => {
      log("[mcp] Tool called: list_tasks", JSON.stringify({ status }));
      const tasks = getTasks(status);
      return { content: [{ type: "text" as const, text: JSON.stringify(tasks) }] };
    }
  );

  // --- add_task ---
  server.tool(
    "add_task",
    "Add a new kanban task to the user's board. Defaults to the 'todo' column.",
    {
      title: z.string().describe("Short title for the task"),
      description: z.string().optional().describe("Optional longer description"),
      status: z.enum(["todo", "doing", "done"]).optional().describe("Column to place it in (defaults to 'todo')"),
    },
    async ({ title, description, status }) => {
      log("[mcp] Tool called: add_task", JSON.stringify({ title, status }));
      const task = addTask(randomUUID(), title, description, (status ?? "todo") as TaskStatus);
      broadcastEvent({ event: "task_updated", task: task as unknown as Record<string, unknown> });
      return { content: [{ type: "text" as const, text: `Added task "${task.title}" to ${task.status}. id=${task.id}` }] };
    }
  );

  // --- update_task ---
  server.tool(
    "update_task",
    "Update an existing kanban task's title, description, or status (column). Use this to move tasks between columns (e.g., status='doing' to start work, status='done' to complete).",
    {
      id: z.string().describe("The task ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().nullable().optional().describe("New description (or null to clear)"),
      status: z.enum(["todo", "doing", "done"]).optional().describe("Move to a different column"),
    },
    async ({ id, title, description, status }) => {
      log("[mcp] Tool called: update_task", JSON.stringify({ id, title, status }));
      const task = updateTask(id, { title, description, status: status as TaskStatus | undefined });
      if (!task) return { content: [{ type: "text" as const, text: `Task ${id} not found` }] };
      broadcastEvent({ event: "task_updated", task: task as unknown as Record<string, unknown> });
      return { content: [{ type: "text" as const, text: `Updated task "${task.title}" (${task.status})` }] };
    }
  );

  // --- delete_task ---
  server.tool(
    "delete_task",
    "Permanently delete a kanban task by ID.",
    {
      id: z.string().describe("The task ID to delete"),
    },
    async ({ id }) => {
      log("[mcp] Tool called: delete_task", JSON.stringify({ id }));
      const ok = deleteTask(id);
      if (ok) broadcastEvent({ event: "task_deleted", id });
      return { content: [{ type: "text" as const, text: ok ? `Task ${id} deleted` : `Task ${id} not found` }] };
    }
  );

  // --- Smart Home Tools ---
  registerSmartHomeTools(server);

  // --- Web Tools ---
  registerWebTools(server);

  return server;
}

export async function initMCP(): Promise<{ client: Client; createAgentMcpServer: () => McpServer }> {
  // Server #1: connected via InMemoryTransport for direct tool calls (routes, etc.)
  const server = createMCPServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  log("[mcp] MCP server connected (internal)");

  const client = new Client({ name: "ai-assistant-agent", version: "1.0.0" });
  await client.connect(clientTransport);
  log("[mcp] MCP client connected");

  // Log available tools
  const { tools } = await client.listTools();
  log(`[mcp] Available tools: ${tools.map((t) => t.name).join(", ")}`);

  // Factory for creating fresh MCP server instances for the Agent SDK
  // (each query() call needs its own unconnected server)
  log("[mcp] Agent MCP server factory ready");

  return { client, createAgentMcpServer: createMCPServer };
}
