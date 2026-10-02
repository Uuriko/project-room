import { spawnCommand } from "./spawn.mjs";

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function kill(child) {
  try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* exited */ } }
}

// Speak MCP (LSP framing) to a cua-driver mcp process reached through
// `lume ssh`, so the driver runs in the guest. The tool list is whatever
// that process reports.
export function openDriver(vm) {
  const child = spawnCommand("lume", ["ssh", vm, "--", "cua-driver", "mcp"]);
  let buffer = Buffer.alloc(0);
  const waiters = new Map();
  let nextId = 1;
  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      if (message.id != null && waiters.has(message.id)) {
        const resolve = waiters.get(message.id);
        waiters.delete(message.id);
        resolve(message);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error("driver timed out")); }, 8000);
    waiters.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
  });
  const notify = method => { child.stdin.write(encodeMessage({ jsonrpc: "2.0", method })); };
  return {
    async initialize() {
      await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "room-machine", version: "0.1.0" },
      });
      notify("notifications/initialized");
      const listed = await request("tools/list", {});
      const tools = listed.result?.tools ?? [];
      return tools.map(tool => tool.name).filter(name => typeof name === "string");
    },
    call(name, args) { return request("tools/call", { name, arguments: args ?? {} }); },
    close() { kill(child); },
  };
}
