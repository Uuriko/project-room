// Test harness, not an AI host integration or a production dependency.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export async function openMcpTestClient(configDirectory) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./agent-mcp.mjs", import.meta.url))], {
    env: { ROOM_AGENT_CONFIG: configDirectory }, stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map(); let buffer = "", sequence = 0, diagnostics = "";
  const stopped = new Promise(resolve => child.once("exit", resolve));
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
  child.stdout.on("data", chunk => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      pending.get(response.id)?.resolve(response); pending.delete(response.id);
    }
  });
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
