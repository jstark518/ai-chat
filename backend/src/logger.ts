import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../../data");
const LOG_PATH = path.join(LOG_DIR, "backend.log");

// Ensure log directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* already exists */ }

// Open a write stream for the log file (append mode)
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

const CONSOLE_MAX_LINE = 300;

function timestamp(): string {
  return new Date().toISOString();
}

/** Format args into a single line with full content (no truncation). */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ");
}

function writeToFile(level: string, args: unknown[]) {
  // File gets the FULL untruncated content
  const line = `[${timestamp()}] [${level}] ${formatArgs(args)}\n`;
  logStream.write(line);
}

function consoleFormat(args: unknown[]): unknown[] {
  // Truncate long strings in console output for readability
  return args.map((a) => {
    if (typeof a === "string" && a.length > CONSOLE_MAX_LINE) {
      return a.slice(0, CONSOLE_MAX_LINE) + `… [+${a.length - CONSOLE_MAX_LINE} chars]`;
    }
    return a;
  });
}

export function log(...args: unknown[]) {
  console.log(`[${timestamp()}]`, ...consoleFormat(args));
  writeToFile("INFO", args);
}

export function warn(...args: unknown[]) {
  console.warn(`[${timestamp()}]`, ...consoleFormat(args));
  writeToFile("WARN", args);
}

export function error(...args: unknown[]) {
  console.error(`[${timestamp()}]`, ...consoleFormat(args));
  writeToFile("ERROR", args);
}
