import { useEffect, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";
import type { ChatMessage, DeviceInfo } from "../hooks/useChat";
import { KanbanBoard } from "./KanbanBoard";

export function ChatTab() {
  const { messages, connected, isAssistantTyping, selectedOptions, sendMessage, selectOption, controlDevice } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new messages / typing changes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Defer so DOM has painted
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length, isAssistantTyping]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage(text);
    inputRef.current?.focus();
  };

  return (
    <div className="flex gap-6 justify-center items-start flex-wrap lg:flex-nowrap">
      <div className="w-full lg:w-[480px] flex-shrink-0 bg-gray-950 rounded-2xl border border-gray-800 overflow-hidden flex flex-col h-[calc(100vh-180px)] min-h-[500px]">
        {/* Nav bar */}
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">Assistant</h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
              <span className="text-[10px] text-gray-500">{connected ? "Connected" : "Disconnected"}</span>
            </div>
          </div>
        </div>

        {/* Message list */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-1">
          {messages.length === 0 && (
            <div className="text-center text-gray-600 text-sm py-12">No messages yet</div>
          )}
          {messages.map((msg, i) => (
            <MessageRow
              key={msg.id}
              message={msg}
              prevMessage={i > 0 ? messages[i - 1] : undefined}
              selectedOption={selectedOptions[msg.id]}
              onOptionSelected={(opt) => selectOption(msg.id, opt)}
              onDeviceControl={controlDevice}
            />
          ))}
          {isAssistantTyping && <TypingIndicator />}
        </div>

        {/* Compose bar */}
        <div className="border-t border-gray-800 p-2.5 flex-shrink-0">
          <div className="flex items-center gap-2 bg-gray-900 rounded-full px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Message..."
              className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="w-7 h-7 rounded-full bg-blue-500 disabled:bg-gray-700 disabled:opacity-50 flex items-center justify-center transition-colors hover:bg-blue-400 flex-shrink-0"
              aria-label="Send"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Kanban side panel */}
      <div className="w-full lg:flex-1 lg:max-w-[900px] bg-gray-900/50 rounded-2xl border border-gray-800 p-4 h-[calc(100vh-180px)] min-h-[500px] overflow-y-auto">
        <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
          <span>📋</span> Tasks
        </h3>
        <KanbanBoard compact />
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function shouldShowTimestamp(current: ChatMessage, previous?: ChatMessage): boolean {
  if (!previous) return true;
  const curTime = new Date(current.timestamp).getTime();
  const prevTime = new Date(previous.timestamp).getTime();
  // 5 minute gap
  return curTime - prevTime > 5 * 60 * 1000;
}

interface MessageRowProps {
  message: ChatMessage;
  prevMessage?: ChatMessage;
  selectedOption?: string;
  onOptionSelected: (option: string) => void;
  onDeviceControl: (deviceId: string, action: string, params: Record<string, unknown>) => void;
}

function MessageRow({ message, prevMessage, selectedOption, onOptionSelected, onDeviceControl }: MessageRowProps) {
  const isUser = message.role === "user";
  const showTimestamp = shouldShowTimestamp(message, prevMessage);

  return (
    <>
      {showTimestamp && (
        <div className="text-center text-[10px] text-gray-600 font-medium py-2">
          {formatTimestamp(message.timestamp)}
        </div>
      )}
      <div className={`flex ${isUser ? "justify-end pl-14" : "justify-start pr-14"}`}>
        {message.type === "question" && (
          <QuestionBubble content={message.content} />
        )}
        {message.type === "multiple_choice" && (
          <MultipleChoiceBubble
            message={message}
            selectedOption={selectedOption}
            onOptionSelected={onOptionSelected}
          />
        )}
        {message.type === "smart_home_card" && message.devices && (
          <SmartHomeCard
            title={message.content}
            devices={message.devices}
            onDeviceControl={onDeviceControl}
          />
        )}
        {(message.type === "text" || !["question", "multiple_choice", "smart_home_card"].includes(message.type)) && (
          <TextBubble content={message.content} isUser={isUser} />
        )}
      </div>
    </>
  );
}

function TextBubble({ content, isUser }: { content: string; isUser: boolean }) {
  return (
    <div
      className={`px-3 py-2 rounded-2xl max-w-[80%] text-[14px] leading-snug break-words whitespace-pre-wrap ${
        isUser
          ? "bg-blue-500 text-white rounded-br-md"
          : "bg-gray-800 text-gray-100 rounded-bl-md"
      }`}
    >
      {content}
    </div>
  );
}

function QuestionBubble({ content }: { content: string }) {
  return (
    <div className="px-3 py-2 rounded-2xl rounded-bl-md max-w-[80%] bg-indigo-600 text-white text-[14px] leading-snug flex items-start gap-2">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 mt-0.5">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round"/>
        <circle cx="12" cy="17" r="1" fill="#4f46e5" />
      </svg>
      <span className="flex-1">{content}</span>
    </div>
  );
}

function MultipleChoiceBubble({
  message,
  selectedOption,
  onOptionSelected,
}: {
  message: ChatMessage;
  selectedOption?: string;
  onOptionSelected: (option: string) => void;
}) {
  const isAnswered = selectedOption !== undefined;
  return (
    <div className="px-3 py-2.5 rounded-2xl rounded-bl-md max-w-[85%] bg-indigo-600 text-white text-[14px] leading-snug">
      <div className="flex items-start gap-2 mb-2.5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 mt-0.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 10h8 M8 14h5" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <span className="flex-1">{message.content}</span>
      </div>
      <div className="space-y-1.5">
        {(message.options ?? []).map((option) => {
          const isSelected = selectedOption === option;
          return (
            <button
              key={option}
              onClick={() => !isAnswered && onOptionSelected(option)}
              disabled={isAnswered}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition-colors ${
                isSelected
                  ? "bg-white/40 text-white"
                  : "bg-white/15 text-white hover:bg-white/25"
              } ${isAnswered && !isSelected ? "opacity-50" : ""} ${isAnswered ? "cursor-default" : ""}`}
            >
              <span>{option}</span>
              {isSelected && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M7 12l3 3 7-7" stroke="#4f46e5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SmartHomeCard({
  title,
  devices,
  onDeviceControl,
}: {
  title: string;
  devices: DeviceInfo[];
  onDeviceControl: (deviceId: string, action: string, params: Record<string, unknown>) => void;
}) {
  return (
    <div className="px-3 py-2.5 rounded-2xl rounded-bl-md max-w-[90%] bg-gray-800 text-gray-100 w-full">
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-1.5">
        {devices.map((d) => (
          <DeviceRow key={d.id} device={d} onDeviceControl={onDeviceControl} />
        ))}
      </div>
    </div>
  );
}

function DeviceRow({
  device,
  onDeviceControl,
}: {
  device: DeviceInfo;
  onDeviceControl: (deviceId: string, action: string, params: Record<string, unknown>) => void;
}) {
  if (device.deviceType === "light") {
    const on = device.on ?? false;
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
            style={{
              backgroundColor: on
                ? (device.color && device.color !== "#FFFFFF" ? device.color : "#FFD60A")
                : "#3f3f46",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={on ? "#fff" : "#71717a"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18h6 M10 22h4 M12 2a7 7 0 0 1 4 12.7V17H8v-2.3A7 7 0 0 1 12 2z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-white truncate">{device.name}</div>
            <div className="text-[11px] text-gray-500">
              {on ? `On${device.brightness != null ? ` · ${device.brightness}%` : ""}` : "Off"}
              {device.source && device.source !== "mock" ? ` · ${device.source}` : ""}
            </div>
          </div>
        </div>
        <Toggle on={on} onChange={(next) => onDeviceControl(device.id, "power", { on: next })} />
      </div>
    );
  }
  if (device.deviceType === "lock") {
    const locked = device.locked ?? false;
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${locked ? "bg-green-600" : "bg-red-500"}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              {locked ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 8 0" />}
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-white truncate">{device.name}</div>
            <div className="text-[11px] text-gray-500">{locked ? "Locked" : "Unlocked"}</div>
          </div>
        </div>
        <Toggle on={locked} onChange={(next) => onDeviceControl(device.id, "lock", { locked: next })} />
      </div>
    );
  }
  if (device.deviceType === "thermostat") {
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-7 h-7 rounded-full bg-orange-500 flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-white truncate">{device.name}</div>
            <div className="text-[11px] text-gray-500">
              {device.currentTemp != null ? `${Math.round(device.currentTemp)}°` : "—"}
              {device.targetTemp != null ? ` → ${Math.round(device.targetTemp)}°` : ""}
              {device.mode ? ` · ${device.mode}` : ""}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (device.deviceType === "sensor") {
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-7 h-7 rounded-full bg-purple-500 flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v6 M12 17v6 M4.22 4.22l4.24 4.24 M15.54 15.54l4.24 4.24 M1 12h6 M17 12h6 M4.22 19.78l4.24-4.24 M15.54 8.46l4.24-4.24" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-white truncate">{device.name}</div>
            <div className="text-[11px] text-gray-500">
              {device.sensorType}{device.state ? ` · ${device.state}` : ""}
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${on ? "bg-green-500" : "bg-gray-600"}`}
      aria-label={on ? "Turn off" : "Turn on"}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${
          on ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start pr-14">
      <div className="px-3 py-2.5 rounded-2xl rounded-bl-md bg-gray-800">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    </div>
  );
}
