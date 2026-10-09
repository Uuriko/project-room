// Test harness, not an AI host integration or a production dependency.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Line router for the child's stdout: split newline-delimited JSON-RPC
// messages, resolve pending requests by id, and quarantine malformed lines
// (log noise, a stray blank line, a truncated write) instead of letting an
// unguarded JSON.parse crash the whole harness process.
export function createMcpLineRouter({ resolve, malformed }) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { malformed(line); continue; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { malformed(line); continue; }
        resolve(message);
      }
    },
  };
}
export async function openMcpTestClient(configDirectory, { attentionDirectory, attentionVersion } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./agent-mcp.mjs", import.meta.url))], {
    env: { ROOM_AGENT_CONFIG: configDirectory, ...(attentionDirectory === undefined ? {} : { ROOM_AGENT_ATTENTION_DIR: attentionDirectory }),
      ...(attentionVersion === undefined ? {} : { ROOM_AGENT_ATTENTION_VERSION: String(attentionVersion) }) }, stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map(); let sequence = 0, diagnostics = "";
  const stopped = new Promise(resolve => child.once("exit", resolve));
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
  const router = createMcpLineRouter({
    resolve: response => { pending.get(response.id)?.resolve(response); pending.delete(response.id); },
    malformed: line => { diagnostics = (diagnostics + `malformed MCP stdout line: ${line.slice(0, 200)}\n`).slice(-4096); },
  });
  child.stdout.on("data", chunk => router.push(chunk));
  child.on("exit", () => { for (const entry of pending.values()) entry.reject(new Error("MCP process exited")); pending.clear(); });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const request = (method, params = {}) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP test deadline")); }, 10000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "room-protocol-exercise", version: "1" } });
  notify("notifications/initialized");
  return { initialized, request, call: (name, args = {}) => request("tools/call", { name, arguments: args }),
    close: async () => { child.stdin.end(); await stopped; return { diagnostics }; } };
}
