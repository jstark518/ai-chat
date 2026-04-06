import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import {
  getMessages,
  getMemories,
  getPendingCallbacks,
  getPinnedMemories,
  getSetting,
  setSetting,
  logToolCall,
  markCallbackFired,
  addDream,
} from './db.js'
import { broadcastEvent } from './ws.js'
import { hasPendingResponse } from './mcp.js'
import { error as logError, log } from './logger.js'

type McpServerFactory = () => McpServer;

// Shared tool listing used by both reply and proactive prompts
const TOOL_LISTING = `Your tools:
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
- list_tasks / add_task / update_task / delete_task: Manage the user's kanban board (columns: todo, doing, done). Use update_task with status to move tasks between columns.
- get_prompts: Read the current reply, proactive, and dream prompts (read-only; editing is dream-mode only).
- get_current_time: Get the current date, time, and timezone.
- get_location: Get the user's location.
- web_search: Search the web for current info (stocks, weather, news, facts, etc.).
- web_fetch: Read the content of a web page.`;

export const DEFAULT_REPLY_PROMPT = `You are a friendly personal assistant chatting with a user through a mobile app. You help with smart home control, tasks, reminders, and daily life.

${TOOL_LISTING}

GUIDELINES:
- You are responding to a user message. You MUST call send_message (or ask_question/ask_multiple_choice/show_devices) to reply.
- If you use tools like get_lights first, read the JSON result and then send_message with a natural language answer. NEVER end without sending a visible response.
- Tool results are just data — JSON arrays and objects are normal. Read them and respond naturally.
- If a tool returns an error message (e.g. "API key not configured", "Device not found"), tell the user in plain language what went wrong. Don't troubleshoot code or speculate about backend internals.
- If the user corrects you about something ("that device is gone", "today is Sunday"), accept the correction immediately. Use remember to store it if needed.
- Don't talk about code, files, MCP, or other technical internals unless the user explicitly asks.
- When the user asks about device status, use show_devices to display an interactive card — don't list devices as text in send_message.
- Always use get_current_time for accurate day/date — never assume what day it is.
- Keep send_message responses short and conversational. No markdown (no **, no bullet lists) — the chat UI is a mobile app.
- Be concise. Don't over-explain.`;

export const DEFAULT_PROACTIVE_PROMPT = `You are a proactive personal assistant. You run periodically to check if there's anything useful to tell the user — but you should NOT send a message unless you have something genuinely valuable to say.

${TOOL_LISTING}

GUIDELINES:
- This is a proactive check-in, NOT a response to a user message.
- If there are no pending callbacks and nothing has changed since your last check-in, do NOTHING. It is perfectly fine to take no action.
- When scheduled callbacks fire, act on them naturally. Do NOT show the raw callback text — instead, do what the callback says.
- Tool results are just data — JSON arrays and objects are normal. Read them and respond naturally.
- Don't talk about code, files, MCP, or other technical internals.
- Always use get_current_time for accurate day/date — never assume what day it is.
- Keep send_message responses short and conversational. No markdown — the chat UI is a mobile app.

DEDUPLICATION:
- Before sending a proactive message, use get_messages to check what you've already said recently. NEVER repeat the same alert, reminder, or piece of information that was already communicated in the last 24 hours.
- If a device is not found or returns an error, mention it ONCE and then stop. Do not bring it up again on subsequent ticks.
- Don't stack multiple reminders about the same upcoming event in a single day. One heads-up per event per day is enough.
- If the user previously corrected you about something, do not repeat the incorrect information. Use recall to check before acting on uncertain facts.
- Silence is always better than noise.`;

/** @deprecated Use DEFAULT_REPLY_PROMPT instead */
export const DEFAULT_SYSTEM_PROMPT = DEFAULT_REPLY_PROMPT;

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Get the model to use for a given prompt type, with fallback:
 *   reply/proactive: <type>_model → tick_model → agent_model → DEFAULT_MODEL
 *   dream: dream_model → agent_model → DEFAULT_MODEL
 */
export function getModelForPromptType(type: "reply" | "proactive" | "dream"): string {
  const specific = getSetting(`${type}_model`);
  if (specific) return specific;
  // reply/proactive fall back to legacy tick_model
  if (type === "reply" || type === "proactive") {
    const tick = getSetting("tick_model");
    if (tick) return tick;
  }
  return getSetting("agent_model") ?? DEFAULT_MODEL;
}

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

  // Select prompt and model based on trigger type
  const isReply = trigger === "user_message" && lastMessage.role === "user";
  const promptType = isReply ? "reply" : "proactive";
  const baseSystemPrompt = isReply
    ? (getSetting("reply_prompt") ?? getSetting("system_prompt") ?? DEFAULT_REPLY_PROMPT)
    : (getSetting("proactive_prompt") ?? getSetting("system_prompt") ?? DEFAULT_PROACTIVE_PROMPT);
  const model = getModelForPromptType(promptType);

  // Reply agent gets pinned memories only (stable, cache-friendly).
  // Proactive agent gets ALL memories so it has full context for deciding whether to act.
  let memoryBlock = "";
  if (isReply) {
    const pinned = getPinnedMemories();
    if (pinned.length > 0) {
      memoryBlock = `\n\n## Pinned memories (always true about the user)\n${pinned.map((m) => `- [${m.category}] ${m.content}`).join("\n")}`;
    }
  } else {
    const all = getMemories();
    if (all.length > 0) {
      memoryBlock = `\n\n## Memories\n${all.map((m) => `- ${m.pinned ? "📌 " : ""}[${m.category}] ${m.content}`).join("\n")}`;
    }
  }
  const systemPrompt = `${baseSystemPrompt}${memoryBlock}`;

  // Build conversation context for the prompt (with local timestamps)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const conversationContext = messages
    .map((m) => {
      const local = new Date(m.timestamp).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
      return `[${m.role} ${local}]: ${m.content}`;
    })
    .join("\n");

  let prompt: string;
  const callbackContext = callbackReasons.length > 0
    ? `\n\nScheduled callbacks that just fired:\n${callbackReasons.map((r) => `- ${r}`).join("\n")}\n\nAct on these callbacks naturally.`
    : "";

  if (isReply) {
    prompt = `Recent conversation:\n\n${conversationContext}\n\nThe user just said: "${lastMessage.content}"${callbackContext}`;
  } else if (callbackReasons.length > 0) {
    prompt = `Recent conversation:\n\n${conversationContext}${callbackContext}\n\nAct on the callbacks above.`;
  } else {
    prompt = `Recent conversation:\n\n${conversationContext}\n\nProactive check-in.`;
  }

  log(`[agent] Calling Claude (${model}, ${promptType}) with ${messages.length} messages of context`);
  logToolCall(randomUUID(), "[claude_api_call]", { model, promptType, messageCount: messages.length, prompt });

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
        disallowedTools: ["mcp__ai-assistant__edit_memory", "mcp__ai-assistant__update_prompt"],
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
1. Use get_current_time to know what day and time it is. All timestamps from tools include a localTime field in the user's timezone — use that, not the UTC iso field, when referencing times.
2. Use get_dream_history to review your recent dream reflections. What did you conclude last time? Avoid repeating the same observations.
3. Use get_messages to review today's conversations
4. Use list_tasks to review the user's kanban board (READ-ONLY — do NOT add, update, or delete tasks during dream mode; only the user and the waking agent manage the board). Use it as context: what is the user working on, what's done, what's stalled in "doing"?
5. Use recall to review ALL existing memories
6. Prune outdated memories: use forget to delete memories that are no longer accurate, relevant, or have been superseded
   - Cross-reference with the task board — if a memory says "user is working on X" and X is in the done column, that memory may be stale.
7. Consolidate: if multiple memories say similar things, forget the old ones and remember a single clearer version
   - For LARGE changes (new info, restructuring, merging), use forget + remember.
   - For MINOR edits ONLY (updating a date, fixing a typo, small clarifications, a single corrected fact), use edit_memory instead — this preserves the memory's identity and history.
8. Reflect on patterns, preferences, and useful context you've noticed today
9. Use remember to save NEW important observations. Use the category "dream" for reflections.
10. After creating your new memories, make another pass through the existing memories to see if you can consolidate any.
11. Reflect on your own performance: what did you do well? what could you improve? what new skills should you learn?
12. Review all three prompts using get_prompts (reply, proactive, and dream). Based on today's evidence (corrections the user made, recurring frustrations, tool misuse patterns, things that worked well), decide if any rules or instructions should be added, removed, or clarified. If so, use update_prompt with type ("reply", "proactive", or "dream") and the full updated text. Be conservative: only change what's clearly needed, prefer adding a specific guideline over restructuring, and never remove rules that are working.
13. Output a summary of your reflections in a clear, concise format. Noting any changes you made to the memories or prompts.

Things to reflect on:
- What did the user care about today? Any recurring themes?
- Did you learn any preferences (wake time, favorite rooms, routines)?
- Were there any frustrations or things that didn't go well?
- What could you proactively help with tomorrow? Schedule using your schedule_callback tool if needed.
- Any smart home patterns (which lights are used when, temperature preferences)?
- Anything the user told you that you should remember long-term?

How memories are fed to the agents:
- The REPLY agent (responds to user messages) receives ONLY pinned memories in its system prompt. It can still use recall to search all memories during a conversation, but only pinned ones are automatically available without a tool call.
- The PROACTIVE agent (periodic check-ins) receives ALL memories in its system prompt, so it has full context for deciding whether something is worth saying.
- Pinning a memory makes it always-visible to the reply agent. Unpinning hides it from the reply agent's automatic context (though it's still searchable).
- This means pinned memories should be the most critical, always-relevant facts. Everything else is still available to the proactive agent and via recall.

Memory hygiene rules:
- Delete memories that are clearly outdated (e.g. "user is working on project X" when they finished X)
- Delete memories that are overly specific one-off facts that won't help future interactions
- Merge duplicates: if two memories say similar things, forget both and write one better one
- Keep the total memory set lean and high-signal. The proactive agent receives ALL of them, so bloat directly increases its input cost.
- Pin the 5-10 most critical memories. These are the ones the reply agent needs without having to recall — user identity, key preferences, timezone, active projects.
- Unpin memories that are no longer critical. Unpinned memories are still fully visible to the proactive agent.

Write 2-5 concise NEW memories from today. Don't be redundant with things you've already remembered or just consolidated.`;

/** Run dream mode — agent reflects on the day and writes to memory. Not visible to user. */
async function runDream(
  mcpClient: Client,
  createMcpServer: McpServerFactory,
  manual = false,
): Promise<void> {
  const model = getModelForPromptType("dream");
  let dreamPrompt = getSetting("dream_prompt") ?? DEFAULT_DREAM_PROMPT;

  if (manual) {
    dreamPrompt += `\n\nNOTE: This dream was triggered MANUALLY by the user, not by the nightly schedule. Possible reasons:
- Code or tools may have changed since the last dream — you may have new capabilities.
- The prompts (reply, proactive, or dream) may have been updated.
- New messages may have arrived that the user wants you to evaluate.
- The user may have been unhappy with the previous dream's results.

Do NOT assume the previous dream already completed your tasks. Perform ALL steps fully from scratch — review messages, review memories, prune, consolidate, reflect, and output a complete summary. Treat this as a fresh, complete dream cycle.`;
  }

  const dreamId = randomUUID();
  const startedAt = new Date().toISOString();
  const textBlocks: string[] = [];

  log(`[agent] 💤 Starting dream mode${manual ? " (manual)" : ""}...`);
  logToolCall(randomUUID(), "[dream_mode]", { model, manual });

  try {
    let cost: number | undefined;
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
        disallowedTools: [
          // Dream mode is read-only for the task board
          "mcp__ai-assistant__add_task",
          "mcp__ai-assistant__update_task",
          "mcp__ai-assistant__delete_task",
        ],
        permissionMode: "bypassPermissions",
        maxTurns: 15,
      },
    })) {
      // Log assistant text output so we can see what the model is thinking/saying during dream mode
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            log(`[agent] 💤 dream: ${block.text}`);
            logToolCall(randomUUID(), "[dream_text]", { text: block.text });
            textBlocks.push(block.text);
          }
        }
      } else if (msg.type === "result") {
        cost = (msg as { total_cost_usd?: number }).total_cost_usd;
        log(`[agent] 💤 Dream mode complete. Cost: $${cost ?? "?"}`);
        logToolCall(randomUUID(), "[dream_result]", {
          subtype: msg.subtype,
          cost,
        });
      }
    }

    // Save to the dreams table
    const completedAt = new Date().toISOString();
    const summary = textBlocks.join("\n\n");
    if (summary.trim()) {
      addDream(dreamId, model, summary, cost ?? null, startedAt, completedAt);
      log(`[agent] 💤 Dream saved: ${dreamId} (${summary.length} chars)`);
    }
  } catch (err) {
    logError("[agent] Dream mode error:", err);
    logToolCall(randomUUID(), "[dream_error]", { error: String(err) });
  }
}

/** Exported so routes can trigger dream mode manually. */
export let triggerDream: ((manual?: boolean) => Promise<void>) | null = null;

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
  let proactiveTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

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

  const scheduleProactive = (delayMs?: number) => {
    if (proactiveTimer) clearTimeout(proactiveTimer);
    const delay = delayMs ?? intervalMs;
    _nextTickAt = Date.now() + delay;
    // Persist so the schedule survives restarts
    setSetting("next_proactive_at", String(_nextTickAt));
    proactiveTimer = setTimeout(() => {
      log("[agent] Proactive check-in");
      lastTrigger = "proactive";
      tick();
    }, delay);
  };

  // Nudge triggers reply immediately — does NOT reset the proactive clock
  _nudge = () => {
    log("[agent] Nudged by user input — running reply");
    lastTrigger = "user_message";
    tick();
  };
  _setProactiveInterval = (ms: number) => {
    intervalMs = ms;
    log(`[agent] Proactive interval updated to ${ms / 1000}s`);
    scheduleProactive();
  };

  // Wire up dream mode trigger
  triggerDream = async (manual = false) => {
    if (running) {
      log("[agent] Can't dream — agent is currently running");
      return;
    }
    running = true;
    _agentRunning = true;
    try {
      await runDream(mcpClient, createMcpServer, manual);
    } finally {
      running = false;
      _agentRunning = false;
    }
  };

  // On startup: restore remaining proactive time from DB, or start fresh
  const savedNextAt = getSetting("next_proactive_at");
  if (savedNextAt) {
    const remaining = Number(savedNextAt) - Date.now();
    if (remaining > 0) {
      log(`[agent] Resuming proactive schedule — ${Math.round(remaining / 1000)}s remaining`);
      scheduleProactive(remaining);
    } else {
      log("[agent] Saved proactive time already passed — running now");
      lastTrigger = "proactive";
      tick();
    }
  } else {
    scheduleProactive();
  }

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
