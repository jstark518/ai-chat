# AI Assistant

A proactive virtual assistant that runs on an interval, checking in with you via an iOS app. Instead of waiting passively for commands, the agent periodically evaluates whether there's anything worth doing — checking the time, your location, your smart home state, and its own memories — and takes action using a suite of MCP tools.

Think of it as a smart home companion that actually starts conversations.

## What it does

- **Runs on a schedule.** Every few minutes the agent wakes up with a prompt like "Anything worth doing?" and decides whether to act, ask a question, or stay quiet.
- **Controls your smart home.** Unified control over Govee (cloud) and TP-Link Kasa (local network) devices — lights, plugs, light strips — plus a mock device layer for testing.
- **Chats with you.** Real-time messaging via WebSocket with typing indicators and read receipts, rendered as native chat bubbles in the iOS app.
- **Remembers things.** Long-term memory, pinnable notes that always stay in context, and a "dream mode" that runs daily to consolidate and prune old memories.
- **Shows interactive cards.** The agent can send smart-home cards directly into the chat with live device controls the user can tap.
- **Schedules callbacks.** The agent can tell itself "wake me up in 2 hours and remind the user about X."
- **Pulls live data.** Tools for web search, current time/date, user location, and message history.

## Architecture

This is a monorepo with three packages.

### `backend/` — TypeScript agent service
The brains. A Hono HTTP server with a WebSocket endpoint, a SQLite database, an MCP server exposing 30+ tools, and a scheduler that invokes the Claude Agent SDK on a cron-like loop.

- **`index.ts`** — Hono server, WebSocket hub, agent loop bootstrap
- **`agent.ts`** — The `query()` loop against `@anthropic-ai/claude-agent-sdk`, system prompts, scheduling
- **`mcp.ts`** — MCP server with user-facing tools (ask_question, send_message, memories, callbacks, etc.)
- **`smarthome.ts`** — Unified smart-home MCP tools + scene engine
- **`govee.ts`** — Govee cloud API v2 client
- **`kasa.ts`** — LAN discovery + control for TP-Link Kasa devices
- **`db.ts`** — SQLite schema, migrations, CRUD
- **`ws.ts`** — WebSocket broadcast + event types

### `ios/` — Native SwiftUI app
Targets iOS 18+. Acts as both the chat UI **and** a tool provider — the backend can ask the iOS app for the user's location over WebSocket and the app will respond with CoreLocation data.

- Chat view with markdown-free bubbles, typing indicators, read receipts
- Multiple choice question prompts rendered as tappable buttons
- Smart home cards with live WebSocket-driven state updates
- Local notifications when messages arrive in the background
- `Config.swift` (gitignored) for backend URLs — see setup below

### `web/` — React smart-home dashboard
A React 19 + Vite + Tailwind v4 app for discovering, organizing, and debugging your smart home devices.

- Auto-discovery of Kasa devices on the LAN
- Govee device sync from the cloud
- Room assignment, live state display
- Settings panel for API keys, system prompt overrides, debug log viewer

## Tech Stack

- **Backend**: TypeScript, Hono, `@hono/node-ws`, better-sqlite3, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, zod
- **iOS**: SwiftUI, CoreLocation, UserNotifications, URLSessionWebSocketTask
- **Web**: React 19, Vite, Tailwind v4, TypeScript
- **Smart home**: Govee cloud API v2, `tplink-smarthome-api` (LAN)

## MCP Tools

The agent has access to a rich tool surface, all exposed through an in-process MCP server via `InMemoryTransport`:

| Category | Tools |
|---|---|
| Communication | `send_message`, `ask_question`, `ask_multiple_choice` |
| User context | `get_location`, `get_messages`, `get_current_time` |
| Memory | `remember`, `recall_memories`, `pin_memory`, `forget_memory` |
| Scheduling | `set_reminder`, `schedule_callback` |
| Web | `web_search` |
| Smart home (unified) | `get_lights`, `set_light`, `set_lights`, `set_room`, `show_devices`, `get_all_devices`, `sync_devices` |
| Smart home (other) | `get_thermostat`, `set_thermostat`, `get_locks`, `set_lock`, `get_sensors`, `get_scenes`, `activate_scene` |

Smart-home tools are source-agnostic: a light ID like `govee:H6008:ABCD...` or `kasa:ABC123` is routed automatically to the right backend.

## Setup

### Backend

```sh
npm install
npm run dev
```

The backend starts on port 8136 by default. Set `PORT` to override.

**API keys** (optional, set via the web dashboard's Settings panel or directly in the `settings` table):
- `govee_api_key` — from [developer.govee.com](https://developer.govee.com)
- `anthropic_api_key` — **not required** if using Claude Code's Max subscription
- `tavily_api_key` — for `web_search` tool

### Web Dashboard

```sh
npm run dev:web
# or npm run dev to start both backend + web
```

Dashboard runs on Vite's default port (usually 5173).

### iOS App

1. Copy the config template:
   ```sh
   cp ios/AIAssistant/Config.example.swift ios/AIAssistant/Config.swift
   ```
2. Edit `Config.swift` with your backend URL (e.g. `https://your-tunnel.example.com` and `wss://your-tunnel.example.com/ws`). This file is gitignored.
3. Open `ios/AIAssistant.xcodeproj` in Xcode.
4. Build and run on simulator or device.

For remote access from a real device, expose the backend via a tunnel (Cloudflare Tunnel, ngrok, Tailscale, etc.).

## Database Safety

**Never delete `data/assistant.db`.** It holds room assignments, device caches, memories, conversation history, API keys, and settings — months of accumulated state.

Schema changes go through the `migrations` array in `backend/src/db.ts`, using `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` statements. These are idempotent and safe to run on existing databases.

Before any risky change:
```sh
cp data/assistant.db "data/assistant.db.backup-$(date +%Y%m%d-%H%M%S)"
```

## API Reference

### REST
- `GET  /health` — health check
- `GET  /api/messages` — fetch recent messages
- `POST /api/messages` — send a user message `{ content }`
- `GET  /api/location` — last known user location
- `POST /api/location` — update location `{ latitude, longitude }`
- `GET  /api/smarthome/state` — unified smart-home snapshot
- `PUT  /api/smarthome/lights/:id` — control a light
- `PUT  /api/smarthome/devices/:id/room` — assign a device to a room
- `DELETE /api/smarthome/devices/:id` — remove a device from the cache
- `POST /api/kasa/devices/discover` — run LAN discovery
- `POST /api/govee/sync` — sync from Govee cloud

### WebSocket
`GET /ws` — bidirectional JSON messages. Event types:
- `Message` — assistant/user chat message
- `typing` — `{ event: "typing", typing: bool }`
- `read` — `{ event: "read", messageIds: [...] }`
- `device_state_update` — live device state push
- `device_control` — client → server control command
- `request_location` / `location_response` — backend requests location, iOS responds

## Commands

```sh
npm run dev           # Backend + web dashboard, concurrently
npm run dev:backend   # Backend only (nodemon, 10s debounce)
npm run dev:web       # Web dashboard only
npm run build         # tsc compile
npm start             # Run compiled backend
```

## Roadmap

- **APNS push notifications** — currently uses local notifications; need a `.p8` key and `POST /api/devices/register` for real push.
- **Publish to App Store** — the iOS app is ready but needs packaging.
- **Voice I/O** — the agent is text-only for now.

## License

Personal project, no license yet.
