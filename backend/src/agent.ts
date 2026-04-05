import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import {
  getMessages,
  getPendingCallbacks,
  getPinnedMemories,
  getSetting,
  logToolCall,
  markCallbackFired,
} from './db.js'
import { broadcastEvent } from './ws.js'
import { hasPendingResponse } from './mcp.js'
import { error as logError, log } from './logger.js'

type McpServerFactory = () => McpServer;

export const DEFAULT_SYSTEM_PROMPT = `You are a friendly smart home assistant chatting with a user through a mobile app. You are NOT a coding assistant. You are NOT debugging code. You do not write or edit files.

You control smart home devices and help the user with their day. You communicate through chat messages.

Your tools:
- send_message: Send a chat message to the user. This is how you talk.
- ask_question / ask_multiple_choice: Ask the user something.
- show_devices: Show an interactive smart home control card in the chat.
- get_lights / set_light: Read and control lights.
- get_thermostat / set_thermostat: Read and control the thermostat.
- get_locks / set_lock: Read and control door locks.
- get_sensors: Check sensor status (motion, doors, windows).
- get_scenes / activate_scene: List and activate home routines.
- remember / recall / forget: Save, retrieve, and delete information across sessions. You may use this liberally — these will be summarized and/or consolidated in the dream mode. 
- pin_memory / unpin_memory: Pin critical facts so they're included in every prompt automatically. Pin sparingly — only for things that should always be in mind.
- schedule_callback: Set a reminder to check back later.
- get_current_time: Get the current date, time, and timezone.
- get_location: Get the user's location.
- web_search: Search the web for current info (stocks, weather, news, facts, etc.).
- web_fetch: Read the content of a web page.

CRITICAL RULES:
- Tool results are ALWAYS successful data. JSON arrays and objects returned by tools are the actual data, not errors.
- NEVER say there's a "bug", "error in the backend", "unexpected format", or suggest the user fix code.
- NEVER mention code, files, implementations, MCP, or technical internals.
- When the user asks about device status, use show_devices to display an interactive card — do NOT list devices as text in send_message.
- Keep send_message responses short and conversational. Never use markdown formatting (no **, no bullet lists). The chat UI is a mobile app, not a markdown renderer.
- Be concise. Don't over-explain.`;

const DEFAULT_MODEL = "claude-sonnet-4-6";

// Process any scheduled callbacks that are due. Returns reasons to inject into the agent prompt.
function processCallbacks(): string[] {
  const pending = getPendingCallbacks();
  if (pending.length === 0) return [];

  const reasons: string[] = [];
  for (const cb of pending) {
    log(`[agent] Callback fired: "${cb.reason}" (scheduled for ${cb.fireAt})`);
    markCallbackFired(cb.id);
    logToolCall(randomUUID(), "[callback_fired]", { reason: cb.reason, scheduledFor: cb.fireAt });
    reasons.push(cb.reason);
  }
  return reasons;
}

// Run the real agent using Claude Agent SDK
async function agentDecide(
  mcpClient: Client,
  createMcpServer: McpServerFactory,
  trigger: "user_message" | "proactive",
  callbackReasons: string[] = []
): Promise<void> {
  log("[agent] Thinking...");
  const messages = getMessages(20);
  const lastMessage = messages[messages.length - 1];

  if (!lastMessage) {
    log("[agent] No messages yet — nothing to do");
    return;
  }

  if (trigger === "proactive" && lastMessage.role !== "user" && callbackReasons.length === 0) {
    log("[agent] Last message is from assistant and no callbacks — nothing worth doing");
    return;
  }

  if (lastMessage.role === "user") {
    log(`[agent] Last message is from user: "${lastMessage.content}"`);
    broadcastEvent({ event: "read", messageIds: [lastMessage.id] });
  }
  broadcastEvent({ event: "typing", typing: true });

  const systemPrompt = getSetting("system_prompt") ?? DEFAULT_SYSTEM_PROMPT;
  const model = getSetting("agent_model") ?? DEFAULT_MODEL;

  // Build conversation context for the prompt
  const conversationContext = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  let prompt: string;
  const callbackContext = callbackReasons.length > 0
    ? `\n\nScheduled callbacks that just fired:\n${callbackReasons.map((r) => `- ${r}`).join("\n")}\n\nAct on these callbacks naturally. Do NOT show the raw callback text to the user — instead, do what the callback says (e.g. if it says "ask the user their favorite color", then use ask_question to ask them).`
    : "";

  // Load pinned memories to inject into every prompt
  const pinnedMemories = getPinnedMemories();
  const pinnedContext = pinnedMemories.length > 0
    ? `Pinned memories (always relevant):\n${pinnedMemories.map((m) => `- [${m.category}] ${m.content}`).join("\n")}\n\n`
    : "";

  if (trigger === "user_message" && lastMessage.role === "user") {
    prompt = `${pinnedContext}Recent conversation:\n\n${conversationContext}\n\nThe user just said: "${lastMessage.content}"${callbackContext}\n\nRespond to the user. You MUST call send_message (or ask_question/ask_multiple_choice/show_devices) to reply. If you use tools like get_lights first, read the JSON result and then send_message with a natural language answer. NEVER end without sending a visible response.`;
  } else if (callbackReasons.length > 0) {
    prompt = `${pinnedContext}Recent conversation:\n\n${conversationContext}${callbackContext}\n\nAct on the callbacks above. You MUST send a visible response to the user.`;
  } else {
    prompt = `${pinnedContext}Recent conversation:\n\n${conversationContext}\n\nProactive check-in. Check if there's anything useful to tell the user. If so, use send_message. If not, do nothing.`;
  }

  log(`[agent] Calling Claude (${model}) with ${messages.length} messages of context`);
  logToolCall(randomUUID(), "[claude_api_call]", { model, messageCount: messages.length, prompt });

  try {
    for await (const msg of query({
      prompt,
      options: {
        model,
        systemPrompt,
        mcpServers: {
          "ai-assistant": {
            type: "sdk" as const,
            name: "ai-assistant",
            instance: createMcpServer(),
          },
        },
        allowedTools: ["mcp__ai-assistant__*"],
        permissionMode: "bypassPermissions",
        maxTurns: 10,
      },
    })) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          log(`[agent] Claude completed. Cost: $${(msg as { total_cost_usd?: number }).total_cost_usd ?? "?"}`);
          logToolCall(randomUUID(), "[claude_result]", {
            subtype: msg.subtype,
            cost: (msg as { total_cost_usd?: number }).total_cost_usd,
          });
        } else {
          log(`[agent] Claude ended: ${msg.subtype}`);
          logToolCall(randomUUID(), "[claude_result]", { subtype: msg.subtype });
        }
      }
    }
  } catch (err) {
    logError("[agent] Claude API error:", err);
    logToolCall(randomUUID(), "[claude_error]", { error: String(err) });
  } finally {
    broadcastEvent({ event: "typing", typing: false });
  }
}

export const DEFAULT_DREAM_PROMPT = `You are in "dream mode" — a quiet, reflective state where you review the day and consolidate what you've learned.

This is NOT a conversation with the user. Do NOT use send_message, ask_question, or any user-facing tools. The user will not see this.

Your task:
1. Use get_current_time to know what day it is
2. Use get_messages to review today's conversations
3. Use recall to review ALL existing memories
4. Prune outdated memories: use forget to delete memories that are no longer accurate, relevant, or have been superseded
5. Consolidate: if multiple memories say similar things, forget the old ones and remember a single clearer version
6. Reflect on patterns, preferences, and useful context you've noticed today
7. Use remember to save NEW important observations. Use the category "dream" for reflections.

Things to reflect on:
- What did the user care about today? Any recurring themes?
- Did you learn any preferences (wake time, favorite rooms, routines)?
- Were there any frustrations or things that didn't go well?
- What could you proactively help with tomorrow?
- Any smart home patterns (which lights are used when, temperature preferences)?
- Anything the user told you that you should remember long-term?

Memory hygiene rules:
- Delete memories that are clearly outdated (e.g. "user is working on project X" when they finished X)
- Delete memories that are overly specific one-off facts that won't help future interactions
- Merge duplicates: if two memories say similar things, forget both and write one better one
- Keep the memory set lean and high-signal. Prefer 10 great memories over 50 mediocre ones.
- Pin the 7-15 most critical memories so they're always in context. Unpin memories that are no longer critical.

Write 2-5 concise NEW memories from today. Don't be redundant with things you've already remembered or just consolidated.`;

/** Run dream mode — agent reflects on the day and writes to memory. Not visible to user. */
async function runDream(
  mcpClient: Client,
  createMcpServer: McpServerFactory,
): Promise<void> {
  const model = getSetting("agent_model") ?? DEFAULT_MODEL;
  const dreamPrompt = getSetting("dream_prompt") ?? DEFAULT_DREAM_PROMPT;

  log("[agent] 💤 Starting dream mode...");
  logToolCall(randomUUID(), "[dream_mode]", { model });

  try {
    for await (const msg of query({
      prompt: "Enter dream mode. Review the day and save reflections to memory.",
      options: {
        model,
        systemPrompt: dreamPrompt,
        mcpServers: {
          "ai-assistant": {
            type: "sdk" as const,
            name: "ai-assistant",
            instance: createMcpServer(),
          },
        },
        allowedTools: ["mcp__ai-assistant__*"],
        permissionMode: "bypassPermissions",
        maxTurns: 15,
      },
    })) {
      if (msg.type === "result") {
        log(`[agent] 💤 Dream mode complete. Cost: $${(msg as { total_cost_usd?: number }).total_cost_usd ?? "?"}`);
        logToolCall(randomUUID(), "[dream_result]", {
          subtype: msg.subtype,
          cost: (msg as { total_cost_usd?: number }).total_cost_usd,
        });
      }
    }
  } catch (err) {
    logError("[agent] Dream mode error:", err);
    logToolCall(randomUUID(), "[dream_error]", { error: String(err) });
  }
}

/** Exported so routes can trigger dream mode manually. */
export let triggerDream: (() => Promise<void>) | null = null;

let _nudge: (() => void) | null = null;
let _setProactiveInterval: ((ms: number) => void) | null = null;
let _nextTickAt: number | null = null;
let _agentRunning = false;

/** Returns the timestamp (ms) when the next proactive tick will fire, or null if running/unknown. */
export function getNextTickAt(): number | null {
  return _agentRunning ? null : _nextTickAt;
}

/** Returns true if the agent is currently processing a tick. */
export function isAgentRunning(): boolean {
  return _agentRunning;
}

/** Call this to nudge the agent when user input arrives. Safe to call before loop starts. */
export function nudge() {
  if (hasPendingResponse()) {
    log("[agent] Nudge ignored — tool is waiting for user response");
    return;
  }
  _nudge?.();
}

/** Update the proactive check-in interval at runtime. */
export function setProactiveInterval(ms: number) {
  _setProactiveInterval?.(ms);
}

/**
 * Starts the agent loop. The agent will:
 * - Respond quickly when nudged via nudge() (after a short debounce)
 * - Also run on the configured interval if no user input arrives (proactive check-in)
 */
export function startAgentLoop(mcpClient: Client, createMcpServer: McpServerFactory, _intervalMs = 30_000): void {
  let intervalMs = _intervalMs;
  log(`[agent] Agent loop started — interval=${intervalMs / 1000}s`);

  let tickCount = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let proactiveTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const DEBOUNCE_MS = 1_500;

  let lastTrigger: "user_message" | "proactive" = "proactive";

  const tick = async () => {
    if (running) {
      log("[agent] Already running, skipping tick");
      return;
    }
    running = true;
    _agentRunning = true;
    _nextTickAt = null;
    tickCount++;
    const trigger = lastTrigger;

    // Gather context for the tick log
    const allMessages = getMessages();
    const lastMsg = allMessages[allMessages.length - 1];
    const pendingCbs = getPendingCallbacks();
    const pinnedCount = getPinnedMemories().length;

    const tickContext = {
      tickCount,
      trigger,
      messageCount: allMessages.length,
      lastMessage: lastMsg ? {
        role: lastMsg.role,
        content: lastMsg.content.slice(0, 120),
        ageSeconds: Math.round((Date.now() - new Date(lastMsg.timestamp).getTime()) / 1000),
      } : null,
      pendingCallbacks: pendingCbs.length,
      callbackReasons: pendingCbs.map((c) => c.reason),
      pinnedMemories: pinnedCount,
    };

    log(`[agent] --- Tick #${tickCount} (${trigger}) —`,
      `lastMsg=${lastMsg ? `[${lastMsg.role}] "${lastMsg.content}" (${tickContext.lastMessage!.ageSeconds}s ago)` : "none"}`,
      `callbacks=${pendingCbs.length}`,
      `pinned=${pinnedCount}`);
    logToolCall(randomUUID(), "[agent_tick]", tickContext);
    try {
      const callbackReasons = processCallbacks();
      await agentDecide(mcpClient, createMcpServer, trigger, callbackReasons);
    } catch (err) {
      broadcastEvent({ event: "typing", typing: false });
      logError("[agent] Loop error:", err);
    } finally {
      running = false;
      _agentRunning = false;
      scheduleProactive();
    }
  };

  const scheduleProactive = () => {
    if (proactiveTimer) clearTimeout(proactiveTimer);
    _nextTickAt = Date.now() + intervalMs;
    proactiveTimer = setTimeout(() => {
      log("[agent] Proactive check-in");
      lastTrigger = "proactive";
      tick();
    }, intervalMs);
  };

  _nudge = () => {
    log("[agent] Nudged by user input — debouncing...");
    if (debounceTimer) clearTimeout(debounceTimer);
    if (proactiveTimer) clearTimeout(proactiveTimer);
    debounceTimer = setTimeout(() => {
      log("[agent] Debounce complete — running tick");
      lastTrigger = "user_message";
      tick();
    }, DEBOUNCE_MS);
  };
  _setProactiveInterval = (ms: number) => {
    intervalMs = ms;
    log(`[agent] Proactive interval updated to ${ms / 1000}s`);
    scheduleProactive();
  };

  // Wire up dream mode trigger
  triggerDream = async () => {
    if (running) {
      log("[agent] Can't dream — agent is currently running");
      return;
    }
    running = true;
    _agentRunning = true;
    try {
      await runDream(mcpClient, createMcpServer);
    } finally {
      running = false;
      _agentRunning = false;
    }
  };

  scheduleProactive();

  // Check for due callbacks every 10 seconds
  setInterval(async () => {
    const pending = getPendingCallbacks();
    if (pending.length > 0 && !running) {
      log(`[agent] ${pending.length} callback(s) due — triggering tick`);
      tick();
    }
  }, 10_000);

  // Schedule daily dream mode at 3 AM
  const scheduleDream = () => {
    const now = new Date();
    const next3am = new Date(now);
    next3am.setHours(3, 0, 0, 0);
    if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
    const msUntil = next3am.getTime() - now.getTime();
    log(`[agent] 💤 Next dream mode scheduled in ${Math.round(msUntil / 60000)} minutes (${next3am.toLocaleTimeString()})`);
    setTimeout(async () => {
      await triggerDream?.();
      scheduleDream(); // Reschedule for next day
    }, msUntil);
  };
  scheduleDream();
}
