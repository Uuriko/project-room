import { spawnCommand } from "./spawn.mjs";
import { DRIVER_FRAME_MAX_BYTES } from "./protocol.mjs";

// Frame headers are a single "Content-Length: N" line; anything longer
// without the blank-line terminator is a hostile or broken driver.
const FRAME_HEADER_MAX_BYTES = 8192;

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
//
// The driver is untrusted and unreliable: `lume ssh` can fail to spawn,
// the guest process can die mid-request, and a hostile driver can declare
// an absurd Content-Length. Every one of those must reject the pending
// requests promptly — never crash the daemon with an unhandled 'error',
// never leave waiters to time out one by one, and never buffer a frame
// larger than DRIVER_FRAME_MAX_BYTES.
export function openDriver(vm) {
  const child = spawnCommand("lume", ["ssh", vm, "--", "cua-driver", "mcp"]);
  let buffer = Buffer.alloc(0);
  const waiters = new Map();
  let nextId = 1;
  let failure = null;
  let closed = false;

  // Record the first failure and reject every pending waiter with it.
  const settle = error => {
    if (failure) return;
    failure = error;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiters.clear();
  };
  const fail = error => {
    settle(error);
    if (!closed) kill(child);
  };

  child.on("error", error => fail(new Error(`driver process failed: ${error.message}`)));
  child.stdin.on("error", error => fail(new Error(`driver process failed: ${error.message}`)));
  child.stdout.on("error", error => fail(new Error(`driver process failed: ${error.message}`)));
  child.on("exit", (code, signal) => {
    if (closed || failure) return;
    fail(new Error(`driver exited (${signal ? `signal ${signal}` : `code ${code}`}) before answering`));
  });

  child.stdout.on("data", chunk => {
    if (failure) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buffer.length > FRAME_HEADER_MAX_BYTES) {
          fail(new Error(`driver frame header exceeds ${FRAME_HEADER_MAX_BYTES} bytes`));
        }
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > DRIVER_FRAME_MAX_BYTES) {
        fail(new Error(`driver frame length ${match[1]} exceeds the ${DRIVER_FRAME_MAX_BYTES}-byte cap`));
        return;
      }
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      if (message.id != null && waiters.has(message.id)) {
        const waiter = waiters.get(message.id);
        waiters.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });

  const write = payload => {
    try {
      child.stdin.write(payload, error => { if (error) fail(new Error(`driver process failed: ${error.message}`)); });
    } catch (error) {
      fail(new Error(`driver process failed: ${error.message}`));
    }
  };

  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error("driver timed out")); }, 8000);
    waiters.set(id, { resolve, reject, timer });
    write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
  });
  const notify = method => { if (!failure) write(encodeMessage({ jsonrpc: "2.0", method })); };
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
    close() {
      if (closed) return;
      closed = true;
      settle(new Error("driver closed"));
      kill(child);
    },
  };
}
