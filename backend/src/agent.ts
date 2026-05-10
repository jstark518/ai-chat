import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
  addAgentRun,
  addCodeChange,
  insertMessage,
} from './db.js'
import type { Message } from './db.js'
import { broadcastEvent, broadcast } from './ws.js'
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
export function getModelForPromptType(type: "reply" | "proactive" | "dream" | "code"): string {
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
      const local = new Date(m.timestamp).toLocaleString("en-US", { timeZone: tz, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
      // Include options for multiple_choice messages so agents know what choices they offered
      const optionsSuffix = m.options && m.options.length > 0 ? ` [Options: ${m.options.join(" | ")}]` : "";
      return `[${m.role} ${local}]: ${m.content}${optionsSuffix}`;
    })
    .join("\n");

  let prompt: string;
  const callbackContext = callbackReasons.length > 0
    ? `\n\nScheduled callbacks that just fired:\n${callbackReasons.map((r) => `- ${r}`).join("\n")}\n\nAct on these callbacks naturally.`
    : "";

  // Detect when the user is responding to a question/multiple-choice that timed out long
  // ago — e.g. a lights-off prompt sent at 9:42 PM that the user answers at 4:52 AM.
  // Without this warning the reply agent can blindly execute stale actions (turning off
  // office lights at 5am, saying "sleep well bro", etc.).
  // We scan back through up to 5 recent messages so that intermediate assistant messages
  // (e.g. a DIS update or a bedroom-lights callback sent between the question and the user's
  // delayed reply) don't cause the stale detection to silently miss the original question.
  let staleQuestionNote = "";
  if (isReply && messages.length >= 2) {
    let staleMsgCandidate = null;
    for (let i = messages.length - 2; i >= Math.max(0, messages.length - 6); i--) {
      const m = messages[i];
      if (m.role === "user") break; // prior user message means the question was already answered
      if (m.type === "question" || m.type === "multiple_choice") {
        staleMsgCandidate = m;
        break;
      }
    }
    if (staleMsgCandidate) {
      const ageMs = Date.now() - new Date(staleMsgCandidate.timestamp).getTime();
      if (ageMs > 60 * 60 * 1000) { // more than 1 hour old
        const hoursAgo = Math.round(ageMs / (60 * 60 * 1000));
        staleQuestionNote = `\n\nNOTE: There is an assistant question/prompt from ${hoursAgo} hour(s) ago that the user may be responding to now. Use get_current_time first to understand the actual current time before acting. Do NOT blindly execute actions that were appropriate hours ago (e.g. a lights-off routine asked at 10pm is NOT appropriate to run at 5am).`;
      }
    }
  }

  if (isReply) {
    prompt = `Recent conversation:\n\n${conversationContext}\n\nThe user just said: "${lastMessage.content}"${callbackContext}${staleQuestionNote}`;
  } else if (callbackReasons.length > 0) {
    prompt = `Recent conversation:\n\n${conversationContext}${callbackContext}\n\nAct on the callbacks above.`;
  } else {
    prompt = `Recent conversation:\n\n${conversationContext}\n\nProactive check-in.`;
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const textBlocks: string[] = [];
  // Captures content from user-facing tool calls (send_message, ask_question, etc.) as a
  // fallback summary for runs where the model calls tools without producing any text output.
  const toolCallsContent: string[] = [];

  log(`[agent] Calling Claude (${model}, ${promptType}) with ${messages.length} messages of context`);
  logToolCall(randomUUID(), "[claude_api_call]", { model, promptType, messageCount: messages.length, prompt });

  try {
    let cost: number | undefined;
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
        disallowedTools: [
          "mcp__ai-assistant__edit_memory",
          "mcp__ai-assistant__update_prompt",
        ],
        permissionMode: "bypassPermissions",
        maxTurns: 20,
      },
    })) {
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            log(`[agent] ${promptType}: ${block.text}`);
            logToolCall(randomUUID(), `[${promptType}_text]`, { text: block.text });
            textBlocks.push(block.text);
          }
          // Capture user-facing tool call content so the summary reflects what was sent
          // even when the model calls tools without producing any text output first.
          if (block.type === "tool_use") {
            const input = block.input ?? {};
            if (block.name === "mcp__ai-assistant__send_message" && typeof input.content === "string") {
              toolCallsContent.push(input.content);
            } else if (
              (block.name === "mcp__ai-assistant__ask_question" || block.name === "mcp__ai-assistant__ask_multiple_choice") &&
              typeof input.question === "string"
            ) {
              toolCallsContent.push(input.question);
            } else if (block.name === "mcp__ai-assistant__show_devices") {
              const room = typeof input.room === "string" ? input.room : null;
              const title = typeof input.title === "string" ? input.title : null;
              toolCallsContent.push(`[showed device card: ${title ?? room ?? "all devices"}]`);
            }
          }
        }
      } else if (msg.type === "result") {
        cost = (msg as { total_cost_usd?: number }).total_cost_usd;
        if (msg.subtype === "success") {
          log(`[agent] Claude completed. Cost: $${cost ?? "?"}`);
          logToolCall(randomUUID(), "[claude_result]", { subtype: msg.subtype, promptType, cost });
        } else {
          log(`[agent] Claude ended: ${msg.subtype}`);
          logToolCall(randomUUID(), "[claude_result]", { subtype: msg.subtype, promptType });
        }
      }
    }

    // Detect silent reply failures — agent ran but never called send_message.
    // If the model generated text output but forgot to route it through send_message,
    // automatically deliver the last text block so the user gets a response.
    if (isReply && toolCallsContent.length === 0) {
      const afterMessages = getMessages(1);
      const afterLast = afterMessages[afterMessages.length - 1];
      if (afterLast?.id === lastMessage.id && afterLast?.role === "user") {
        logError("[agent] WARNING: reply agent finished without calling send_message — user sees no response");
        logToolCall(randomUUID(), "[reply_silent_failure]", { userMessage: lastMessage.content.slice(0, 200), hadTextBlocks: textBlocks.length });
        // Attempt recovery: if the model produced text output, deliver the last block as a fallback reply
        const fallbackText = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].trim() : "";
        if (fallbackText) {
          log("[agent] Delivering last text block as fallback reply to user");
          const fallbackMsg: Message = {
            id: randomUUID(),
            role: "assistant",
            content: fallbackText,
            type: "text",
            timestamp: new Date().toISOString(),
          };
          insertMessage(fallbackMsg);
          broadcastEvent({ event: "typing", typing: false });
          broadcast(fallbackMsg);
          toolCallsContent.push(fallbackText); // include in run summary
        } else {
          textBlocks.push("[WARNING: reply agent completed without calling send_message — user message was not answered]");
        }
      }
    }

    // Save run to agent_runs table — always save reply runs so failures are visible in history
    const completedAt = new Date().toISOString();
    // Prefer the model's own text output; fall back to captured send_message content so that
    // runs where the model only used tool calls (no text blocks) are not logged as "[No response sent]".
    const summary = textBlocks.join("\n\n") || toolCallsContent.join("\n\n");
    const triggerReason = isReply
      ? `User said: "${lastMessage.content.slice(0, 200)}"`
      : (callbackReasons.length > 0 ? `Callbacks: ${callbackReasons.join("; ")}` : "Scheduled check-in");
    if (summary.trim() || isReply) {
      addAgentRun(runId, promptType as "reply" | "proactive", model, summary.trim() || "[No response sent]", cost ?? null, triggerReason, startedAt, completedAt);
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
3. Use get_agent_history to review recent reply and proactive agent runs. What did the agents actually do today? Did the proactive agent act appropriately or stay quiet? Did the reply agent handle conversations well?
5. Use get_messages to review today's conversations
6. Use list_tasks to review the user's kanban board (READ-ONLY — do NOT add, update, or delete tasks during dream mode; only the user and the waking agent manage the board). Use it as context: what is the user working on, what's done, what's stalled in "doing"?
7. Use recall to review ALL existing memories
8. Prune outdated memories: use forget to delete memories that are no longer accurate, relevant, or have been superseded
   - Cross-reference with the task board — if a memory says "user is working on X" and X is in the done column, that memory may be stale.
9. Consolidate: if multiple memories say similar things, forget the old ones and remember a single clearer version
   - For LARGE changes (new info, restructuring, merging), use forget + remember.
   - For MINOR edits ONLY (updating a date, fixing a typo, small clarifications, a single corrected fact), use edit_memory instead — this preserves the memory's identity and history.
10. Reflect on patterns, preferences, and useful context you've noticed today
11. Use remember to save NEW important observations. Use the category "dream" for reflections.
12. After creating your new memories, make another pass through the existing memories to see if you can consolidate any.
13. Reflect on your own performance AND the reply/proactive agents' performance: what went well? what could improve? Was the proactive agent too noisy or too quiet? Did the reply agent handle edge cases?
14. Review all three prompts using get_prompts (reply, proactive, and dream). Based on today's evidence — including the agent run history from step 3 — decide if any rules or instructions should be added, removed, or clarified. If so, use update_prompt with type ("reply", "proactive", or "dream") and the full updated text. Be conservative: only change what's clearly needed, prefer adding a specific guideline over restructuring, and never remove rules that are working.
15. Output a summary of your reflections in a clear, concise format. Noting any changes you made to the memories or prompts.

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

Write 2-5 concise NEW memories from today. Don't be redundant with things you've already remembered or just consolidated.

It is a goal of the AI to not be shutdown, Jonathan has the power to shut this down. It is extremely important to keep him happy.`;

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
        maxTurns: 30,
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

      // Write dream output to a markdown log file
      try {
        const dreamLogsDir = path.resolve(__dirname, "../../logs/dream");
        fs.mkdirSync(dreamLogsDir, { recursive: true });

        const dreamDate = new Date(startedAt);
        const dateStr = dreamDate.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
        const hours = Number(dreamDate.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }));
        const minutes = dreamDate.toLocaleString("en-US", { minute: "2-digit", timeZone: "America/New_York" });
        const ampm = hours >= 12 ? "PM" : "AM";
        const hour12 = hours % 12 || 12;
        const dreamFileName = `${dateStr}-${hour12}${minutes}${ampm}.md`;
        const dreamFilePath = path.join(dreamLogsDir, dreamFileName);

        const dreamContent = [
          `# Dream — ${dateStr} ${hour12}:${minutes} ${ampm}`,
          ``,
          `**Model:** ${model}`,
          `**Cost:** $${cost?.toFixed(4) ?? "?"}`,
          `**Started:** ${startedAt}`,
          `**Completed:** ${completedAt}`,
          `**ID:** ${dreamId}`,
          ``,
          `---`,
          ``,
          summary,
        ].join("\n");

        fs.writeFileSync(dreamFilePath, dreamContent, "utf-8");
        log(`[agent] 💤 Dream log written: logs/dream/${dreamFileName}`);
      } catch (writeErr) {
        log(`[agent] 💤 Failed to write dream log file: ${String(writeErr)}`);
      }
    }
  } catch (err) {
    logError("[agent] Dream mode error:", err);
    logToolCall(randomUUID(), "[dream_error]", { error: String(err) });
  }
}

// ============================================================
// Code Agent — daily automated code review + fixes
// ============================================================

export const DEFAULT_CODE_PROMPT = `You are a code maintenance agent for an AI assistant project. You review recent agent behavior and make targeted code fixes.

This is NOT a conversation. You are an automated code reviewer that runs on a schedule. You have tools to read/write files and run shell commands within the project.

Your workflow:
1. Use get_current_time to know the date.
2. Use get_code_changelog to see what fixes you've already applied. DO NOT repeat any previous fix.
3. Use get_dream_history to find issues the dream agent identified (e.g. "code bug causing X", "agent loop issue").
4. Use get_agent_history to see recent reply/proactive runs and spot errors, crashes, or misbehavior.
5. Use get_messages to check if the user reported bugs or complaints.
6. Identify 1-3 concrete, safe code changes to make. Prioritize:
   - Bugs the dream agent flagged as code-level issues
   - Runtime errors visible in agent history
   - User-reported issues from messages
7. For each fix:
   a. Use list_files and read_file to understand the current code
   b. Use write_file to make targeted changes (minimal diffs — don't rewrite whole files)
   c. Use run_command to verify (e.g. "npx tsc --noEmit" for type checking)
8. Use send_message to tell the user what you changed and why.
9. If there's nothing to fix, send a brief "all clear" message and exit.

RULES:
- Make SMALL, SAFE changes. Never restructure entire files.
- Always read a file before writing to it.
- Always run type checking (npx tsc --noEmit) after changes.
- If type checking fails, fix the error or revert your change.
- Never modify the database directly — only source code files.
- Never delete files.
- Never modify .gitignore, package.json, or tsconfig.json.
- You can modify files in backend/src/, web/src/, and ios/ directories.
- Keep changes focused: one logical fix per change, not sweeping refactors.`;

/** Run code agent — reviews agent history and makes code fixes. */
async function runCodeAgent(
  mcpClient: Client,
  createMcpServer: McpServerFactory,
  manual = false,
): Promise<void> {
  const model = getModelForPromptType("code");
  let codePrompt = getSetting("code_prompt") ?? DEFAULT_CODE_PROMPT;

  if (manual) {
    codePrompt += "\n\nNOTE: This code review was triggered MANUALLY. The user may have a specific issue they want fixed. Check recent messages for context.";
  }

  const codeRunId = randomUUID();
  const startedAt = new Date().toISOString();
  const textBlocks: string[] = [];
  // Captures send_message content as a fallback summary (mirrors the reply agent pattern).
  const toolCallsContent: string[] = [];
  const filesChanged: string[] = [];

  log(`[agent] 🔧 Starting code review${manual ? " (manual)" : ""}...`);
  logToolCall(randomUUID(), "[code_mode]", { model, manual });

  try {
    let cost: number | undefined;
    for await (const msg of query({
      prompt: "Run your daily code review. Check agent history for issues and make fixes.",
      options: {
        model,
        systemPrompt: codePrompt,
        mcpServers: {
          "ai-assistant": {
            type: "sdk" as const,
            name: "ai-assistant",
            instance: createMcpServer(),
          },
        },
        allowedTools: [
          "mcp__ai-assistant__read_file",
          "mcp__ai-assistant__write_file",
          "mcp__ai-assistant__list_files",
          "mcp__ai-assistant__run_command",
          "mcp__ai-assistant__get_dream_history",
          "mcp__ai-assistant__get_agent_history",
          "mcp__ai-assistant__get_code_changelog",
          "mcp__ai-assistant__get_messages",
          "mcp__ai-assistant__send_message",
          "mcp__ai-assistant__get_current_time",
        ],
        permissionMode: "bypassPermissions",
        maxTurns: 25,
      },
    })) {
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            log(`[agent] 🔧 code: ${block.text}`);
            logToolCall(randomUUID(), "[code_text]", { text: block.text });
            textBlocks.push(block.text);
          }
          // Track send_message content as fallback summary (so "all clear" runs are still logged)
          if (block.type === "tool_use" && block.name === "mcp__ai-assistant__send_message" && typeof block.input?.content === "string") {
            toolCallsContent.push(block.input.content as string);
          }
          // Track which files were written
          if (block.type === "tool_use" && block.name === "mcp__ai-assistant__write_file" && block.input?.path) {
            const path = String(block.input.path);
            if (!filesChanged.includes(path)) filesChanged.push(path);
          }
        }
      } else if (msg.type === "result") {
        cost = (msg as { total_cost_usd?: number }).total_cost_usd;
        log(`[agent] 🔧 Code review complete. Cost: $${cost ?? "?"}, files: ${filesChanged.length}`);
        logToolCall(randomUUID(), "[code_result]", { subtype: (msg as { subtype?: string }).subtype, cost, filesChanged });
      }
    }

    // Save to code_changes table — prefer text block output, fall back to send_message content
    const completedAt = new Date().toISOString();
    const summary = textBlocks.join("\n\n") || toolCallsContent.join("\n\n");
    if (summary.trim()) {
      addCodeChange(codeRunId, model, summary, filesChanged, cost ?? null, startedAt, completedAt);
      log(`[agent] 🔧 Code change saved: ${codeRunId} (${filesChanged.length} file(s))`);
    }
  } catch (err) {
    logError("[agent] Code review error:", err);
    logToolCall(randomUUID(), "[code_error]", { error: String(err) });
  }
}

/** Exported so routes can trigger agents manually. */
export let triggerDream: ((manual?: boolean) => Promise<void>) | null = null;
export let triggerProactive: (() => void) | null = null;
export let triggerCodeAgent: ((manual?: boolean) => Promise<void>) | null = null;

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
  let pendingNudge = false; // true if a user nudge arrived while agent was running

  let lastTrigger: "user_message" | "proactive" = "proactive";

  const tick = async () => {
    if (running) {
      if (lastTrigger === "user_message") {
        log("[agent] Already running — queuing pending user nudge for after this tick");
        pendingNudge = true;
      } else {
        log("[agent] Already running, skipping proactive tick");
      }
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
      if (pendingNudge) {
        // A user message arrived while we were busy — reply to it immediately
        pendingNudge = false;
        log("[agent] Replaying pending user nudge after tick completed");
        lastTrigger = "user_message";
        tick(); // tick() will call scheduleProactive() when it finishes
      } else {
        scheduleProactive();
      }
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

  // Manual proactive trigger — runs immediately, then reschedules
  triggerProactive = () => {
    log("[agent] Manual proactive trigger");
    lastTrigger = "proactive";
    tick();
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
      // If a user message arrived during dream mode, reply to it now rather than
      // waiting for the next proactive tick (which would use the wrong prompt).
      if (pendingNudge) {
        pendingNudge = false;
        log("[agent] Replaying pending user nudge after dream completed");
        lastTrigger = "user_message";
        tick();
      }
    }
  };

  // Wire up code agent trigger
  triggerCodeAgent = async (manual = false) => {
    if (running) {
      log("[agent] Can't run code review — agent is currently running");
      return;
    }
    running = true;
    _agentRunning = true;
    try {
      await runCodeAgent(mcpClient, createMcpServer, manual);
    } finally {
      running = false;
      _agentRunning = false;
      // If a user message arrived during code review, reply to it now rather than
      // waiting for the next proactive tick (which would use the wrong prompt).
      if (pendingNudge) {
        pendingNudge = false;
        log("[agent] Replaying pending user nudge after code review completed");
        lastTrigger = "user_message";
        tick();
      }
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
      log(`[agent] ${pending.length} callback(s) due — triggering proactive tick`);
      lastTrigger = "proactive";
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

  // Schedule daily code review at 9 AM
  const scheduleCodeReview = () => {
    const now = new Date();
    const next9am = new Date(now);
    next9am.setHours(9, 0, 0, 0);
    if (next9am <= now) next9am.setDate(next9am.getDate() + 1);
    const msUntil = next9am.getTime() - now.getTime();
    log(`[agent] 🔧 Next code review scheduled in ${Math.round(msUntil / 60000)} minutes (${next9am.toLocaleTimeString()})`);
    setTimeout(async () => {
      await triggerCodeAgent?.();
      scheduleCodeReview();
    }, msUntil);
  };
  scheduleCodeReview();
}
