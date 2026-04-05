# AI Assistant

A proactive virtual assistant that runs on an interval, checking in with the user via an iOS app. The agent periodically evaluates whether there's anything worth doing and takes action using available tools.

## Repo Structure

This is a **monorepo** with three packages:

- **`backend/`** — TypeScript agent service that runs on a scheduled interval with a prompt like "Anything worth doing?" Uses the Claude API / Agent SDK to reason and act.
- **`ios/`** — Native Swift iOS app for communicating with the assistant. Serves as the user-facing interface and provides device capabilities (location, notifications, etc.) to the agent.
- **`web/`** — React smart home dashboard for mocking and controlling smart home state.

## iOS Setup

The iOS app needs a `Config.swift` file with your backend URL. This file is gitignored (it contains your private endpoint). To set up:

```sh
cp ios/AIAssistant/Config.example.swift ios/AIAssistant/Config.swift
# Then uncomment the contents and edit Config.swift with your URLs
```

## ⚠️ Database Safety Rules

**NEVER delete `data/assistant.db`** — it contains user room assignments, Govee/Kasa device caches, memories, conversation history, API keys, and settings. User has lost data multiple times from deletions.

**ALWAYS back up the database before making changes to it.** Before any schema change, migration, or any operation that could affect data:
```sh
cp data/assistant.db "data/assistant.db.backup-$(date +%Y%m%d-%H%M%S)"
```

**Schema changes must use migrations** — add `ALTER TABLE ... ADD COLUMN` or `CREATE TABLE IF NOT EXISTS` entries to the `migrations` array in `backend/src/db.ts`. These are safe to run repeatedly on existing databases. Never drop tables or delete the DB file to apply schema changes.

## Key Concepts

- The agent is **proactive**, not purely reactive. It runs periodically and decides if action is needed.
- The iOS app is both a **communication channel** (chat UI) and a **tool provider** (location, etc.).
- Tools are exposed via an **MCP server** (Model Context Protocol) using `@modelcontextprotocol/sdk`.
- The agent calls tools through an **MCP client** connected via `InMemoryTransport` (same process).
- Available MCP tools:
  - **ask_question** — ask the user a free-form question
  - **ask_multiple_choice** — ask a multiple choice question with options
  - **send_message** — send a text message to the user
  - **get_location** — get the user's last known location
  - **get_messages** — get recent message history
  - **set_reminder** — schedule a reminder message
  - **get_lights / set_light** — smart home light control
  - **get_thermostat / set_thermostat** — temperature and mode
  - **get_locks / set_lock** — door lock control
  - **get_sensors** — motion, door, window sensors
  - **get_scenes / activate_scene** — smart home routines
  - **govee_get_devices / govee_get_device_state** — list and query real Govee devices
  - **govee_turn_on_off / govee_set_brightness / govee_set_color** — control Govee lights
  - **govee_control** — raw capability control for any Govee device

## Tech Stack

- **Backend**: TypeScript, Hono, better-sqlite3
- **iOS**: SwiftUI, targeting iOS 18+
- **AI**: Claude API / Anthropic SDK (currently mocked)
- **Tools**: MCP server (`@modelcontextprotocol/sdk`) + zod schemas
- **Networking**: REST (general API) + WebSocket (real-time chat)

## Project Structure

```
backend/src/
  index.ts                            — Entry point (Hono server + WS + agent loop)
  db.ts                               — SQLite database layer (messages, location)
  ws.ts                               — WebSocket client tracking + broadcast
  agent.ts                            — Agent loop (mock AI, calls MCP tools)
  mcp.ts                              — MCP server with tool definitions
  logger.ts                           — Timestamped logging utility
  smarthome.ts                        — Mock smart home state + MCP tools
  routes/
    messages.ts                       — GET/POST /api/messages
    location.ts                       — GET/POST /api/location
    smarthome.ts                      — Smart home REST endpoints
data/                                 — SQLite database files (gitignored)
ios/
  AIAssistant.xcodeproj/             — Xcode project
  AIAssistant/
    AIAssistantApp.swift              — App entry point
    Config.swift                      — Backend URLs (gitignored)
    Config.example.swift              — Template for Config.swift
    Info.plist                        — Permissions (location, etc.)
    Models/Message.swift              — Chat message model
    Views/ChatView.swift              — Main chat UI
    Views/MessageBubbleView.swift     — Message bubble component
    Services/APIService.swift         — REST client
    Services/WebSocketService.swift   — WebSocket client
    Services/LocationService.swift    — CLLocationManager wrapper
web/
  src/
    App.tsx                           — Main app with useSmartHome hook
    api.ts                            — REST client for smart home endpoints
    hooks/useSmartHome.ts             — Polling hook + mutation functions
    components/                       — Dashboard, LightsPanel, ThermostatPanel, etc.
```

## API

- `GET  /health` — Health check
- `GET  /api/messages` — Fetch message history
- `POST /api/messages` — Send a user message `{ content: string }`
- `GET  /api/location` — Get last known user location
- `POST /api/location` — Update user location `{ latitude: number, longitude: number }`
- `GET  /ws` — WebSocket endpoint (sends/receives Message JSON)
- `GET  /api/smarthome/state` — All smart home state (lights, thermostat, locks, sensors, scenes)
- `PUT  /api/smarthome/lights/:id` — Update light `{ on?, brightness?, color? }`
- `PUT  /api/smarthome/thermostat` — Update thermostat `{ targetTemp?, mode? }`
- `PUT  /api/smarthome/locks/:id` — Update lock `{ locked }`
- `POST /api/smarthome/sensors/:id/trigger` — Simulate sensor event
- `POST /api/smarthome/scenes/:id/activate` — Activate a scene

## Commands

```sh
npm run dev      # Start backend with hot reload (tsx watch)
npm run dev:web  # Start web dashboard (Vite dev server)
npm run build    # Compile TypeScript
npm start        # Run compiled backend
# iOS: open ios/AIAssistant.xcodeproj in Xcode
```

## Environment

- `PORT` — Backend port (default: 8136)

## TODO

- **Remote push notifications (APNS)** — iOS currently uses local notifications (only fire when app is backgrounded and running). For true push (notifications when app is killed), need:
  - Apple Developer account + APNS authentication key (.p8)
  - Backend endpoint `POST /api/devices/register` to store device tokens
  - Push send logic in `smarthome.ts`/`mcp.ts` whenever a new assistant message broadcasts
  - iOS: `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` in AIAssistantApp.swift
  - Push capability enabled in Xcode target
