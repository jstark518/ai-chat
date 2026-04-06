import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../../data/assistant.db");

log(`[db] Opening database at ${DB_PATH}`);
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
log("[db] WAL mode enabled");

log("[db] Ensuring tables exist...");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    options TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS location (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lights (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    room TEXT NOT NULL,
    on_state INTEGER NOT NULL DEFAULT 1,
    brightness INTEGER NOT NULL DEFAULT 50,
    color TEXT NOT NULL DEFAULT '#FFFFFF'
  );

  CREATE TABLE IF NOT EXISTS thermostats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    current_temp REAL NOT NULL,
    target_temp REAL NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('heat', 'cool', 'auto', 'off')),
    humidity INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 1,
    last_changed TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sensors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    room TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('motion', 'door', 'window', 'temperature', 'humidity')),
    state TEXT NOT NULL,
    last_triggered TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    actions TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    called_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scheduled_callbacks (
    id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    fire_at TEXT NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kasa_devices (
    device_id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    alias TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'plug',
    model TEXT,
    cached_state TEXT,
    state_fetched_at TEXT,
    room TEXT DEFAULT 'Unassigned',
    last_synced TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS govee_devices (
    device TEXT NOT NULL,
    sku TEXT NOT NULL,
    device_name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'unknown',
    capabilities TEXT NOT NULL DEFAULT '[]',
    cached_state TEXT,
    state_fetched_at TEXT,
    last_synced TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (device, sku)
  );

  CREATE TABLE IF NOT EXISTS dreams (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    summary TEXT NOT NULL,
    cost REAL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL
  );
`);

// --- Migrations (safe to run repeatedly) ---
const migrations = [
  "ALTER TABLE govee_devices ADD COLUMN cached_state TEXT",
  "ALTER TABLE govee_devices ADD COLUMN state_fetched_at TEXT",
  "ALTER TABLE govee_devices ADD COLUMN room TEXT DEFAULT 'Unassigned'",
  "ALTER TABLE messages ADD COLUMN devices TEXT",
  "ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN deleted_at TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

log("[db] Database ready");

export type MessageType = "text" | "question" | "multiple_choice" | "smart_home_card";

export interface DeviceInfo {
  id: string;
  name: string;
  deviceType: "light" | "lock" | "thermostat" | "sensor";
  room?: string;
  // Light fields
  on?: boolean;
  brightness?: number;
  color?: string;
  source?: "mock" | "govee" | "kasa";
  // Lock fields
  locked?: boolean;
  // Thermostat fields
  currentTemp?: number;
  targetTemp?: number;
  mode?: string;
  humidity?: number;
  // Sensor fields
  sensorType?: string;
  state?: string;
  lastTriggered?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  type: MessageType;
  options?: string[];
  devices?: DeviceInfo[];
  timestamp: string;
}

interface RawMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  type: MessageType;
  options: string | null;
  devices: string | null;
  timestamp: string;
}

export function getMessages(limit = 100): Message[] {
  // Get the MOST RECENT `limit` messages, then return them in chronological order
  const rows = db
    .prepare("SELECT * FROM (SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC")
    .all(limit) as RawMessage[];
  const messages = rows.map((row) => ({
    ...row,
    options: row.options ? JSON.parse(row.options) : undefined,
    devices: row.devices ? JSON.parse(row.devices) : undefined,
  }));
  log(`[db] Fetched ${messages.length} messages`);
  return messages;
}

export function insertMessage(message: Message): void {
  log(`[db] Inserting message id=${message.id} role=${message.role} type=${message.type} content="${message.content}"`);
  db.prepare(
    "INSERT INTO messages (id, role, content, type, options, devices, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(message.id, message.role, message.content, message.type, message.options ? JSON.stringify(message.options) : null, message.devices ? JSON.stringify(message.devices) : null, message.timestamp);
}

export interface Location {
  latitude: number;
  longitude: number;
  updated_at: string;
}

export function getLocation(): Location | undefined {
  const loc = db.prepare("SELECT * FROM location WHERE id = 1").get() as
    | Location
    | undefined;
  log(`[db] Get location: ${loc ? `${loc.latitude}, ${loc.longitude} (updated ${loc.updated_at})` : "none"}`);
  return loc;
}

export function upsertLocation(lat: number, lng: number): void {
  log(`[db] Upserting location: ${lat}, ${lng}`);
  db.prepare(
    `INSERT INTO location (id, latitude, longitude, updated_at)
     VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET latitude = ?, longitude = ?, updated_at = datetime('now')`
  ).run(lat, lng, lat, lng);
}

// ============================================================
// Smart Home CRUD
// ============================================================

export interface Light {
  id: string;
  name: string;
  room: string;
  on: boolean;
  brightness: number;
  color: string;
}

interface RawLight {
  id: string;
  name: string;
  room: string;
  on_state: number;
  brightness: number;
  color: string;
}

function mapLight(row: RawLight): Light {
  return { id: row.id, name: row.name, room: row.room, on: row.on_state === 1, brightness: row.brightness, color: row.color };
}

export function getLights(room?: string): Light[] {
  if (room) {
    return (db.prepare("SELECT * FROM lights WHERE room = ?").all(room) as RawLight[]).map(mapLight);
  }
  return (db.prepare("SELECT * FROM lights").all() as RawLight[]).map(mapLight);
}

export function getLight(id: string): Light | undefined {
  const row = db.prepare("SELECT * FROM lights WHERE id = ?").get(id) as RawLight | undefined;
  return row ? mapLight(row) : undefined;
}

export function updateLight(id: string, data: { on?: boolean; brightness?: number; color?: string }): Light | undefined {
  const light = getLight(id);
  if (!light) return undefined;
  if (data.on !== undefined) db.prepare("UPDATE lights SET on_state = ? WHERE id = ?").run(data.on ? 1 : 0, id);
  if (data.brightness !== undefined) db.prepare("UPDATE lights SET brightness = ? WHERE id = ?").run(data.brightness, id);
  if (data.color !== undefined) db.prepare("UPDATE lights SET color = ? WHERE id = ?").run(data.color, id);
  return getLight(id);
}

export function updateLightRoom(id: string, room: string): Light | undefined {
  const result = db.prepare("UPDATE lights SET room = ? WHERE id = ?").run(room, id);
  if (result.changes === 0) return undefined;
  return getLight(id);
}

export function updateGoveeDeviceRoom(device: string, sku: string, room: string): void {
  db.prepare("UPDATE govee_devices SET room = ? WHERE device = ? AND sku = ?").run(room, device, sku);
}

export function deleteLight(id: string): boolean {
  const result = db.prepare("DELETE FROM lights WHERE id = ?").run(id);
  return result.changes > 0;
}

export function deleteGoveeDevice(device: string, sku: string): boolean {
  const result = db.prepare("DELETE FROM govee_devices WHERE device = ? AND sku = ?").run(device, sku);
  return result.changes > 0;
}

// ============================================================
// Kasa Devices
// ============================================================

export interface KasaDeviceRecord {
  deviceId: string;
  host: string;
  alias: string;
  type: string;
  model: string | null;
  cachedState: Record<string, unknown> | null;
  stateFetchedAt: string | null;
  room: string;
  lastSynced: string;
}

interface RawKasaDevice {
  device_id: string;
  host: string;
  alias: string;
  type: string;
  model: string | null;
  cached_state: string | null;
  state_fetched_at: string | null;
  room: string;
  last_synced: string;
}

function mapKasaDevice(row: RawKasaDevice): KasaDeviceRecord {
  return {
    deviceId: row.device_id,
    host: row.host,
    alias: row.alias,
    type: row.type,
    model: row.model,
    cachedState: row.cached_state ? JSON.parse(row.cached_state) : null,
    stateFetchedAt: row.state_fetched_at,
    room: row.room ?? "Unassigned",
    lastSynced: row.last_synced,
  };
}

export function getKasaDevices(): KasaDeviceRecord[] {
  return (db.prepare("SELECT * FROM kasa_devices ORDER BY type, alias").all() as RawKasaDevice[]).map(mapKasaDevice);
}

export function getKasaDevice(deviceId: string): KasaDeviceRecord | undefined {
  const row = db.prepare("SELECT * FROM kasa_devices WHERE device_id = ?").get(deviceId) as RawKasaDevice | undefined;
  return row ? mapKasaDevice(row) : undefined;
}

export function upsertKasaDevice(deviceId: string, host: string, alias: string, type: string, model: string | null): KasaDeviceRecord {
  const now = new Date().toISOString();
  // Preserve existing room
  const existing = getKasaDevice(deviceId);
  const room = existing?.room ?? "Unassigned";
  db.prepare(
    `INSERT INTO kasa_devices (device_id, host, alias, type, model, room, last_synced)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       host = excluded.host,
       alias = excluded.alias,
       type = excluded.type,
       model = excluded.model,
       last_synced = excluded.last_synced`
  ).run(deviceId, host, alias, type, model, room, now);
  return { deviceId, host, alias, type, model, cachedState: existing?.cachedState ?? null, stateFetchedAt: existing?.stateFetchedAt ?? null, room, lastSynced: now };
}

export function updateKasaDeviceState(deviceId: string, state: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE kasa_devices SET cached_state = ?, state_fetched_at = ? WHERE device_id = ?")
    .run(JSON.stringify(state), now, deviceId);
}

export function updateKasaDeviceRoom(deviceId: string, room: string): void {
  db.prepare("UPDATE kasa_devices SET room = ? WHERE device_id = ?").run(room, deviceId);
}

export function deleteKasaDevice(deviceId: string): boolean {
  return db.prepare("DELETE FROM kasa_devices WHERE device_id = ?").run(deviceId).changes > 0;
}

export interface Thermostat {
  id: string;
  name: string;
  currentTemp: number;
  targetTemp: number;
  mode: "heat" | "cool" | "auto" | "off";
  humidity: number;
}

interface RawThermostat {
  id: string;
  name: string;
  current_temp: number;
  target_temp: number;
  mode: "heat" | "cool" | "auto" | "off";
  humidity: number;
}

function mapThermostat(row: RawThermostat): Thermostat {
  return { id: row.id, name: row.name, currentTemp: row.current_temp, targetTemp: row.target_temp, mode: row.mode, humidity: row.humidity };
}

export function getThermostat(): Thermostat | null {
  const row = db.prepare("SELECT * FROM thermostats WHERE id = 'therm-1'").get() as RawThermostat | undefined;
  return row ? mapThermostat(row) : null;
}

export function updateThermostat(data: { targetTemp?: number; mode?: string; currentTemp?: number }): Thermostat | null {
  if (!getThermostat()) return null;
  if (data.targetTemp !== undefined) db.prepare("UPDATE thermostats SET target_temp = ? WHERE id = 'therm-1'").run(data.targetTemp);
  if (data.mode !== undefined) db.prepare("UPDATE thermostats SET mode = ? WHERE id = 'therm-1'").run(data.mode);
  if (data.currentTemp !== undefined) db.prepare("UPDATE thermostats SET current_temp = ? WHERE id = 'therm-1'").run(data.currentTemp);
  return getThermostat();
}

export interface Lock {
  id: string;
  name: string;
  locked: boolean;
  lastChanged: string;
}

interface RawLock {
  id: string;
  name: string;
  locked: number;
  last_changed: string;
}

function mapLock(row: RawLock): Lock {
  return { id: row.id, name: row.name, locked: row.locked === 1, lastChanged: row.last_changed };
}

export function getLocks(): Lock[] {
  return (db.prepare("SELECT * FROM locks").all() as RawLock[]).map(mapLock);
}

export function updateLock(id: string, locked: boolean): Lock | undefined {
  const ts = new Date().toISOString();
  const result = db.prepare("UPDATE locks SET locked = ?, last_changed = ? WHERE id = ?").run(locked ? 1 : 0, ts, id);
  if (result.changes === 0) return undefined;
  const row = db.prepare("SELECT * FROM locks WHERE id = ?").get(id) as RawLock;
  return mapLock(row);
}

export interface Sensor {
  id: string;
  name: string;
  room: string;
  type: "motion" | "door" | "window" | "temperature" | "humidity";
  state: string;
  lastTriggered: string;
}

interface RawSensor {
  id: string;
  name: string;
  room: string;
  type: "motion" | "door" | "window" | "temperature" | "humidity";
  state: string;
  last_triggered: string;
}

function mapSensor(row: RawSensor): Sensor {
  return { id: row.id, name: row.name, room: row.room, type: row.type, state: row.state, lastTriggered: row.last_triggered };
}

export function getSensors(type?: string, room?: string): Sensor[] {
  let sql = "SELECT * FROM sensors";
  const conditions: string[] = [];
  const params: string[] = [];
  if (type) { conditions.push("type = ?"); params.push(type); }
  if (room) { conditions.push("LOWER(room) = LOWER(?)"); params.push(room); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  return (db.prepare(sql).all(...params) as RawSensor[]).map(mapSensor);
}

export function updateSensor(id: string, data: { state: string; lastTriggered: string }): Sensor | undefined {
  const result = db.prepare("UPDATE sensors SET state = ?, last_triggered = ? WHERE id = ?").run(data.state, data.lastTriggered, id);
  if (result.changes === 0) return undefined;
  const row = db.prepare("SELECT * FROM sensors WHERE id = ?").get(id) as RawSensor;
  return mapSensor(row);
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  actions: string[];
}

interface RawScene {
  id: string;
  name: string;
  description: string;
  actions: string;
}

function mapScene(row: RawScene): Scene {
  return { ...row, actions: JSON.parse(row.actions) };
}

export function getScenes(): Scene[] {
  return (db.prepare("SELECT * FROM scenes").all() as RawScene[]).map(mapScene);
}

export function getScene(idOrName: string): Scene | undefined {
  const row = db.prepare("SELECT * FROM scenes WHERE id = ? OR LOWER(name) = LOWER(?)").get(idOrName, idOrName) as RawScene | undefined;
  return row ? mapScene(row) : undefined;
}

// ============================================================
// Settings
// ============================================================

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").run(key, value, value);
}

// ============================================================
// Govee Devices
// ============================================================

export interface GoveeCapability {
  type: string;
  instance: string;
  parameters?: {
    dataType: string;
    options?: Array<{ name: string; value: number | string }>;
    range?: { min: number; max: number; precision: number };
    fields?: unknown[];
  };
  state?: {
    value: unknown;
  };
}

export interface GoveeDeviceRecord {
  device: string;
  sku: string;
  deviceName: string;
  type: string;
  room: string;
  capabilities: GoveeCapability[];
  cachedState: Record<string, unknown> | null;
  stateFetchedAt: string | null;
  lastSynced: string;
}

interface RawGoveeDevice {
  device: string;
  sku: string;
  device_name: string;
  type: string;
  room: string;
  capabilities: string;
  cached_state: string | null;
  state_fetched_at: string | null;
  last_synced: string;
}

// Map SKU prefixes to human-readable device types
const SKU_TYPE_MAP: Record<string, string> = {
  H60: "light",
  H61: "light_strip",
  H62: "light_strip",
  H70: "light",
  H71: "humidifier",
  H713: "humidifier",
  H715: "air_purifier",
  H717: "ice_maker",
  H604: "light",
  H605: "light_strip",
  H6003: "light",
  H6008: "light",
  H6046: "light_strip",
  H6047: "light_strip",
  H6051: "light",
  H6052: "light",
  H6053: "light",
  H6054: "light",
  H6056: "light",
  H6058: "light",
  H6059: "light",
  H6061: "light",
  H6062: "light",
  H6063: "light",
  H6065: "light",
  H6066: "light",
  H6067: "light",
  H607: "light",
  H6072: "light",
  H6073: "light",
  H6075: "light",
  H6076: "light",
  H6078: "light",
  H608: "light",
  H6083: "light",
  H6085: "light",
  H6086: "light",
  H6087: "light",
  H6089: "light",
  H609: "light",
  H610: "light_strip",
  H611: "light_strip",
  H614: "light_strip",
  H615: "light_strip",
  H616: "light_strip",
  H617: "light_strip",
  H618: "light_strip",
  H619: "light_strip",
  H6141: "light_strip",
  H6143: "light_strip",
  H6144: "light_strip",
  H6148: "light_strip",
  H620: "light_strip",
  H700: "heater",
  H7012: "thermometer",
  H7013: "thermometer",
  H702: "humidifier",
  H7050: "fan",
  H7055: "outdoor_light",
  H7060: "outdoor_light",
  H7061: "outdoor_light",
  H7062: "outdoor_light",
  H7065: "outdoor_light",
  H710: "air_purifier",
  H712: "dehumidifier",
  H7130: "humidifier",
  H7131: "humidifier",
  H7132: "humidifier",
  H714: "aroma_diffuser",
  H7140: "air_purifier",
  H7141: "air_purifier",
  H7142: "air_purifier",
  H7143: "air_purifier",
  H7160: "kettle",
  H7170: "ice_maker",
  H7171: "ice_maker",
  H7172: "ice_maker",
};

function classifyDeviceType(sku: string, capabilities: GoveeCapability[]): string {
  // Try exact match first, then progressively shorter prefixes
  for (let len = sku.length; len >= 3; len--) {
    const prefix = sku.slice(0, len);
    if (SKU_TYPE_MAP[prefix]) return SKU_TYPE_MAP[prefix];
  }

  // Infer from capabilities
  const capTypes = capabilities.map((c) => c.type);
  const capInstances = capabilities.map((c) => c.instance);

  if (capInstances.includes("colorRgb") || capInstances.includes("colorTemperatureK")) return "light";
  if (capInstances.includes("brightness")) return "light";
  if (capInstances.includes("humidity")) return "humidifier";
  if (capInstances.includes("temperature")) return "sensor";
  if (capTypes.includes("devices.capabilities.property")) return "sensor";

  return "unknown";
}

function mapGoveeDevice(row: RawGoveeDevice): GoveeDeviceRecord {
  return {
    device: row.device,
    sku: row.sku,
    deviceName: row.device_name,
    type: row.type,
    room: row.room ?? "Unassigned",
    capabilities: JSON.parse(row.capabilities),
    cachedState: row.cached_state ? JSON.parse(row.cached_state) : null,
    stateFetchedAt: row.state_fetched_at,
    lastSynced: row.last_synced,
  };
}

export function getGoveeDevices(): GoveeDeviceRecord[] {
  return (db.prepare("SELECT * FROM govee_devices ORDER BY type, device_name").all() as RawGoveeDevice[]).map(mapGoveeDevice);
}

export function getGoveeDevice(device: string, sku: string): GoveeDeviceRecord | undefined {
  const row = db.prepare("SELECT * FROM govee_devices WHERE device = ? AND sku = ?").get(device, sku) as RawGoveeDevice | undefined;
  return row ? mapGoveeDevice(row) : undefined;
}

export function upsertGoveeDevice(
  device: string,
  sku: string,
  deviceName: string,
  capabilities: GoveeCapability[]
): GoveeDeviceRecord {
  const type = classifyDeviceType(sku, capabilities);
  const capsJson = JSON.stringify(capabilities);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO govee_devices (device, sku, device_name, type, capabilities, last_synced)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device, sku) DO UPDATE SET
       device_name = excluded.device_name,
       type = excluded.type,
       capabilities = excluded.capabilities,
       last_synced = excluded.last_synced`
  ).run(device, sku, deviceName, type, capsJson, now);
  // Preserve existing room if device already exists
  const existing = getGoveeDevice(device, sku);
  const room = existing?.room ?? "Unassigned";
  return { device, sku, deviceName, type, room, capabilities, cachedState: null, stateFetchedAt: null, lastSynced: now };
}

export function syncGoveeDevices(apiDevices: Array<{ device: string; sku: string; deviceName: string; capabilities: GoveeCapability[] }>): GoveeDeviceRecord[] {
  const results: GoveeDeviceRecord[] = [];
  for (const d of apiDevices) {
    results.push(upsertGoveeDevice(d.device, d.sku, d.deviceName, d.capabilities));
  }
  log(`[db] Synced ${results.length} Govee device(s)`);
  return results;
}

export function updateGoveeDeviceState(device: string, sku: string, state: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE govee_devices SET cached_state = ?, state_fetched_at = ? WHERE device = ? AND sku = ?"
  ).run(JSON.stringify(state), now, device, sku);
}

/** Returns true if the cached state is older than maxAgeMs (default 5 minutes). */
export function isGoveeStateStale(device: string, sku: string, maxAgeMs = 5 * 60 * 1000): boolean {
  const row = db.prepare("SELECT state_fetched_at FROM govee_devices WHERE device = ? AND sku = ?").get(device, sku) as { state_fetched_at: string | null } | undefined;
  if (!row?.state_fetched_at) return true;
  return Date.now() - new Date(row.state_fetched_at).getTime() > maxAgeMs;
}

// ============================================================
// Memories
// ============================================================

export interface Memory {
  id: string;
  content: string;
  category: string;
  pinned: boolean;
  createdAt: string;
  deletedAt: string | null;
}

interface RawMemory {
  id: string;
  content: string;
  category: string;
  pinned: number;
  created_at: string;
  deleted_at: string | null;
}

function mapMemory(row: RawMemory): Memory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

export function getMemories(category?: string, includeDeleted = false): Memory[] {
  // Pinned memories first, then by most recent. Filters out soft-deleted by default.
  const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
  if (category) {
    return (db.prepare(`SELECT * FROM memories WHERE category = ? ${deletedClause} ORDER BY pinned DESC, created_at DESC`).all(category) as RawMemory[]).map(mapMemory);
  }
  return (db.prepare(`SELECT * FROM memories WHERE 1=1 ${deletedClause} ORDER BY pinned DESC, created_at DESC`).all() as RawMemory[]).map(mapMemory);
}

export function getPinnedMemories(): Memory[] {
  return (db.prepare("SELECT * FROM memories WHERE pinned = 1 AND deleted_at IS NULL ORDER BY created_at DESC").all() as RawMemory[]).map(mapMemory);
}

export function addMemory(id: string, content: string, category = "general"): Memory {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO memories (id, content, category, created_at) VALUES (?, ?, ?, ?)").run(id, content, category, now);
  return { id, content, category, pinned: false, createdAt: now, deletedAt: null };
}

/** Update a memory's content. Returns the updated memory, or null if not found / soft-deleted. */
export function updateMemory(id: string, content: string): Memory | null {
  const changes = db.prepare("UPDATE memories SET content = ? WHERE id = ? AND deleted_at IS NULL").run(content, id).changes;
  if (changes === 0) return null;
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as RawMemory | undefined;
  return row ? mapMemory(row) : null;
}

/** Soft-delete: sets deleted_at. Memory is hidden from queries but stays in the DB. */
export function deleteMemory(id: string): boolean {
  const now = new Date().toISOString();
  return db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, id).changes > 0;
}

/** Restore a soft-deleted memory. */
export function restoreMemory(id: string): boolean {
  return db.prepare("UPDATE memories SET deleted_at = NULL WHERE id = ?").run(id).changes > 0;
}

/** Permanently delete. Use with care. */
export function hardDeleteMemory(id: string): boolean {
  return db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}

export function setMemoryPinned(id: string, pinned: boolean): boolean {
  return db.prepare("UPDATE memories SET pinned = ? WHERE id = ? AND deleted_at IS NULL").run(pinned ? 1 : 0, id).changes > 0;
}

export function searchMemories(query: string): Memory[] {
  return (db.prepare("SELECT * FROM memories WHERE content LIKE ? AND deleted_at IS NULL ORDER BY pinned DESC, created_at DESC").all(`%${query}%`) as RawMemory[]).map(mapMemory);
}

// ============================================================
// Scheduled Callbacks
// ============================================================

export interface ScheduledCallback {
  id: string;
  reason: string;
  fireAt: string;
  fired: boolean;
  createdAt: string;
}

interface RawScheduledCallback {
  id: string;
  reason: string;
  fire_at: string;
  fired: number;
  created_at: string;
}

function mapCallback(row: RawScheduledCallback): ScheduledCallback {
  return { id: row.id, reason: row.reason, fireAt: row.fire_at, fired: row.fired === 1, createdAt: row.created_at };
}

export function addScheduledCallback(id: string, reason: string, fireAt: string): ScheduledCallback {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO scheduled_callbacks (id, reason, fire_at, created_at) VALUES (?, ?, ?, ?)").run(id, reason, fireAt, now);
  return { id, reason, fireAt, fired: false, createdAt: now };
}

export function getPendingCallbacks(): ScheduledCallback[] {
  const now = new Date().toISOString();
  return (db.prepare("SELECT * FROM scheduled_callbacks WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at ASC").all(now) as RawScheduledCallback[]).map(mapCallback);
}

export function getAllCallbacks(): ScheduledCallback[] {
  return (db.prepare("SELECT * FROM scheduled_callbacks ORDER BY fire_at ASC").all() as RawScheduledCallback[]).map(mapCallback);
}

export function markCallbackFired(id: string): void {
  db.prepare("UPDATE scheduled_callbacks SET fired = 1 WHERE id = ?").run(id);
}

export function deleteCallback(id: string): boolean {
  return db.prepare("DELETE FROM scheduled_callbacks WHERE id = ?").run(id).changes > 0;
}

// ============================================================
// Tool Call Log
// ============================================================

export interface ToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string | null;
  calledAt: string;
}

interface RawToolCall {
  id: string;
  tool_name: string;
  arguments: string;
  result: string | null;
  called_at: string;
}

function mapToolCall(row: RawToolCall): ToolCall {
  return {
    id: row.id,
    toolName: row.tool_name,
    arguments: JSON.parse(row.arguments),
    result: row.result,
    calledAt: row.called_at,
  };
}

export function logToolCall(id: string, toolName: string, args: Record<string, unknown>, result?: string): ToolCall {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO tool_calls (id, tool_name, arguments, result, called_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, toolName, JSON.stringify(args), result ?? null, now);
  return { id, toolName, arguments: args, result: result ?? null, calledAt: now };
}

export function getToolCalls(limit = 50): ToolCall[] {
  return (db.prepare("SELECT * FROM tool_calls ORDER BY called_at DESC LIMIT ?").all(limit) as RawToolCall[]).map(mapToolCall);
}

export function clearToolCalls(): void {
  db.prepare("DELETE FROM tool_calls").run();
}

// ============================================================
// Tasks (Kanban)
// ============================================================

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

interface RawTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function mapTask(row: RawTask): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getTasks(status?: TaskStatus): Task[] {
  if (status) {
    return (db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY sort_order ASC, created_at ASC").all(status) as RawTask[]).map(mapTask);
  }
  return (db.prepare("SELECT * FROM tasks ORDER BY status, sort_order ASC, created_at ASC").all() as RawTask[]).map(mapTask);
}

export function getTask(id: string): Task | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as RawTask | undefined;
  return row ? mapTask(row) : null;
}

export function addTask(id: string, title: string, description?: string, status: TaskStatus = "todo"): Task {
  const now = new Date().toISOString();
  // Put new tasks at the end of the column
  const maxOrder = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE status = ?").get(status) as { m: number }).m;
  const sortOrder = maxOrder + 1;
  db.prepare(
    "INSERT INTO tasks (id, title, description, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, title, description ?? null, status, sortOrder, now, now);
  return { id, title, description: description ?? null, status, sortOrder, createdAt: now, updatedAt: now };
}

export function updateTask(id: string, data: { title?: string; description?: string | null; status?: TaskStatus; sortOrder?: number }): Task | null {
  const existing = getTask(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  // If status is changing and sortOrder not provided, append to the new column
  let newSortOrder = data.sortOrder ?? existing.sortOrder;
  if (data.status && data.status !== existing.status && data.sortOrder === undefined) {
    const maxOrder = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE status = ?").get(data.status) as { m: number }).m;
    newSortOrder = maxOrder + 1;
  }
  db.prepare(
    "UPDATE tasks SET title = ?, description = ?, status = ?, sort_order = ?, updated_at = ? WHERE id = ?"
  ).run(
    data.title ?? existing.title,
    data.description !== undefined ? data.description : existing.description,
    data.status ?? existing.status,
    newSortOrder,
    now,
    id
  );
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  return db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
}

// ============================================================
// Dreams
// ============================================================

export interface Dream {
  id: string;
  model: string;
  summary: string;
  cost: number | null;
  startedAt: string;
  completedAt: string;
}

interface RawDream {
  id: string;
  model: string;
  summary: string;
  cost: number | null;
  started_at: string;
  completed_at: string;
}

function mapDream(row: RawDream): Dream {
  return {
    id: row.id,
    model: row.model,
    summary: row.summary,
    cost: row.cost,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function getDreams(limit = 20): Dream[] {
  return (db.prepare("SELECT * FROM dreams ORDER BY started_at DESC LIMIT ?").all(limit) as RawDream[]).map(mapDream);
}

export function getDream(id: string): Dream | null {
  const row = db.prepare("SELECT * FROM dreams WHERE id = ?").get(id) as RawDream | undefined;
  return row ? mapDream(row) : null;
}

export function addDream(id: string, model: string, summary: string, cost: number | null, startedAt: string, completedAt: string): Dream {
  db.prepare(
    "INSERT INTO dreams (id, model, summary, cost, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, model, summary, cost, startedAt, completedAt);
  return { id, model, summary, cost, startedAt, completedAt };
}

export default db;
