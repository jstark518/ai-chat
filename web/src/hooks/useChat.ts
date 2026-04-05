import { useCallback, useEffect, useRef, useState } from "react";

export interface DeviceInfo {
  id: string;
  name: string;
  deviceType: "light" | "lock" | "thermostat" | "sensor";
  room?: string;
  on?: boolean;
  brightness?: number;
  color?: string;
  source?: string;
  locked?: boolean;
  currentTemp?: number;
  targetTemp?: number;
  mode?: string;
  humidity?: number;
  sensorType?: string;
  state?: string;
  lastTriggered?: string;
}

export type MessageType =
  | "text"
  | "question"
  | "multiple_choice"
  | "smart_home_card";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  type: MessageType;
  options?: string[];
  devices?: DeviceInfo[];
  timestamp: string;
}

type WsEvent =
  | { event: "typing"; typing: boolean }
  | { event: "read"; messageIds: string[] }
  | { event: "device_state_update"; deviceId: string; state: Record<string, unknown> }
  | { event: string; [k: string]: unknown };

function isEvent(data: unknown): data is WsEvent {
  return typeof data === "object" && data !== null && "event" in data;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [isAssistantTyping, setIsAssistantTyping] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/messages");
      if (res.ok) {
        const msgs: ChatMessage[] = await res.json();
        setMessages(msgs);
      }
    } catch {
      // ignore
    }
  }, []);

  const connect = useCallback(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      // reconnect after 2s
      reconnectTimer.current = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      // let onclose handle reconnect
    };
    ws.onmessage = (e) => {
      let data: unknown;
      try { data = JSON.parse(e.data); } catch { return; }
      if (isEvent(data)) {
        if (data.event === "typing") {
          setIsAssistantTyping(!!(data as { typing: boolean }).typing);
        } else if (data.event === "device_state_update") {
          const { deviceId, state } = data as { deviceId: string; state: Record<string, unknown> };
          // Update any smart home card that includes this device
          setMessages((prev) =>
            prev.map((m) => {
              if (m.type !== "smart_home_card" || !m.devices) return m;
              const found = m.devices.some((d) => d.id === deviceId);
              if (!found) return m;
              return {
                ...m,
                devices: m.devices.map((d) =>
                  d.id === deviceId ? { ...d, ...state } : d
                ),
              };
            })
          );
        }
        return;
      }
      // Otherwise it's a Message
      const msg = data as ChatMessage;
      if (msg.id && msg.role) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        if (msg.role === "assistant") setIsAssistantTyping(false);
      }
    };
  }, []);

  useEffect(() => {
    loadHistory();
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, loadHistory]);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: trimmed }),
    });
  }, []);

  const selectOption = useCallback((messageId: string, option: string) => {
    setSelectedOptions((prev) => ({ ...prev, [messageId]: option }));
    // Send option as a regular user message (matches iOS behavior)
    fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: option }),
    });
  }, []);

  const controlDevice = useCallback((deviceId: string, action: string, params: Record<string, unknown>) => {
    wsRef.current?.send(JSON.stringify({ event: "device_control", deviceId, action, params }));
  }, []);

  return {
    messages,
    connected,
    isAssistantTyping,
    selectedOptions,
    sendMessage,
    selectOption,
    controlDevice,
  };
}
