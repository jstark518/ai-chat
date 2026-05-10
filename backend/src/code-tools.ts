import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { log } from "./logger.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

// Safety: ensure all paths are within the project
function safePath(p: string): string {
  const resolved = resolve(PROJECT_ROOT, p);
  const rel = relative(PROJECT_ROOT, resolved);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes project root: ${p}`);
  }
  // Block sensitive paths
  const blocked = ["node_modules", ".git/", ".env", "data/assistant.db"];
  for (const b of blocked) {
    if (rel === b || rel.startsWith(b + "/") || rel.startsWith(b)) {
      // Allow reading from data/ but not the db file itself
      if (b === "data/assistant.db" && rel === "data/assistant.db") {
        throw new Error(`Cannot directly access database file: ${p}`);
      }
      if (b !== "data/assistant.db") {
        throw new Error(`Blocked path: ${p} (matches ${b})`);
      }
    }
  }
  return resolved;
}

// Safety: block destructive commands
const BLOCKED_PATTERNS = [
  /\brm\s+(-rf|-r)\b/,
  /\bgit\s+(push|reset\s+--hard|clean\s+-f)/,
  /\bnpm\s+publish\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bcurl\b.*\|.*\bsh\b/,
  /\bwget\b.*\|.*\bsh\b/,
  /\beval\b/,
  /\b(rm|del)\s+.*assistant\.db/,
];

function assertSafeCommand(cmd: string): void {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      throw new Error(`Blocked command pattern: ${cmd}`);
    }
  }
}

export function registerCodeTools(server: McpServer): void {

  // --- read_file ---
  server.tool(
    "read_file",
    "Read a file from the project. Path is relative to the project root. Returns the file contents as text.",
    {
      path: z.string().describe("Relative path from project root (e.g. 'backend/src/agent.ts')"),
      maxLines: z.number().optional().default(500).describe("Maximum lines to return (default 500)"),
    },
    async ({ path, maxLines }) => {
      log("[mcp] Tool called: read_file", path);
      try {
        const resolved = safePath(path);
        const content = readFileSync(resolved, "utf-8");
        const lines = content.split("\n");
        const truncated = lines.length > maxLines;
        const text = truncated
          ? lines.slice(0, maxLines).join("\n") + `\n\n... (truncated, ${lines.length - maxLines} more lines)`
          : content;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    }
  );

  // --- write_file ---
  server.tool(
    "write_file",
    "Write content to a file in the project. Creates parent directories if needed. Path is relative to the project root.",
    {
      path: z.string().describe("Relative path from project root"),
      content: z.string().describe("The full file content to write"),
    },
    async ({ path, content }) => {
      log("[mcp] Tool called: write_file", path, `(${content.length} chars)`);
      try {
        const resolved = safePath(path);
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, "utf-8");
        return { content: [{ type: "text" as const, text: `Written: ${path} (${content.length} chars)` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    }
  );

  // --- list_files ---
  server.tool(
    "list_files",
    "List files in a directory. Path is relative to project root. Defaults to the project root.",
    {
      path: z.string().optional().default(".").describe("Relative directory path"),
      recursive: z.boolean().optional().default(false).describe("List recursively (max 3 levels deep)"),
    },
    async ({ path, recursive }) => {
      log("[mcp] Tool called: list_files", path);
      try {
        const resolved = safePath(path);
        const files: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 3) return;
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            const full = resolve(dir, entry.name);
            const rel = relative(PROJECT_ROOT, full);
            if (entry.isDirectory()) {
              files.push(rel + "/");
              if (recursive) walk(full, depth + 1);
            } else {
              files.push(rel);
            }
          }
        };
        walk(resolved, 0);
        return { content: [{ type: "text" as const, text: files.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    }
  );

  // --- run_command ---
  server.tool(
    "run_command",
    "Run a shell command in the project root. Use for builds, type-checking, tests, etc. Destructive commands (rm -rf, git push, sudo, etc.) are blocked.",
    {
      command: z.string().describe("Shell command to run"),
      timeoutMs: z.number().optional().default(30000).describe("Timeout in ms (default 30s)"),
    },
    async ({ command, timeoutMs }) => {
      log("[mcp] Tool called: run_command", command);
      try {
        assertSafeCommand(command);
        const result = execSync(command, {
          cwd: PROJECT_ROOT,
          encoding: "utf-8",
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024, // 1MB
          env: { ...process.env, PATH: process.env.PATH },
        });
        return { content: [{ type: "text" as const, text: result || "(no output)" }] };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
        return { content: [{ type: "text" as const, text: `Command failed:\n${output}` }] };
      }
    }
  );
}
