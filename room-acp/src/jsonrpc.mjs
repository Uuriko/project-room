// Minimal JSON-RPC 2.0 peer over newline-delimited JSON (ACP stdio framing).
// Both sides may send requests and notifications. No dependencies.
import { createInterface } from "node:readline";

export class JsonRpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

export function createPeer({ input, output, onRequest = async () => { throw new JsonRpcError(-32601, "Method not found"); }, onNotification = () => {}, onTransportError = () => {}, log = () => {} }) {
  let nextId = 1, closed = false;
  const pending = new Map();
  const write = (message, beforeWrite) => {
    if (closed) return false;
    let frame;
    try { frame = JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"; } catch { return false; }
    // A local guard may commit an execution receipt or refuse the frame.
    // Run it only after serialization and before touching the transport.
    beforeWrite?.();
    try { output.write(frame); return true; } catch { transportFailed(); return false; }
  };
  const failAll = reason => {
    for (const { reject } of pending.values()) reject(new JsonRpcError(-32000, reason));
    pending.clear();
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  const close = reason => {
    if (closed) return false;
    closed = true;
    failAll(reason);
    lines.close();
    return true;
  };
  // A failed stream may have sent a partial frame. Retire the whole peer so
  // neither a later request nor a cancel is appended to that frame.
  function transportFailed(reason = "connection failed") {
    if (close(reason)) onTransportError();
  }
  const onStreamError = () => transportFailed();
  lines.on("error", onStreamError);
  output.on("error", onStreamError);
  output.once("close", () => {
    output.off("error", onStreamError);
    transportFailed();
  });
  lines.on("line", async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { log("jsonrpc: dropped non-JSON line"); return; }
    if (message.method !== undefined && message.id !== undefined) {
      try { write({ id: message.id, result: (await onRequest(message.method, message.params ?? {})) ?? null }); }
      catch (error) { write({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } }); }
    } else if (message.method !== undefined) {
      try { onNotification(message.method, message.params ?? {}); } catch (error) { log(`jsonrpc: notification handler failed: ${error.message}`); }
    } else if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
      else resolve(message.result);
    }
  });
  lines.on("close", () => transportFailed("connection closed"));
  return {
    request(method, params = {}, { timeoutMs = 0, beforeWrite } = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        let timer = null;
        const settle = fn => value => { if (timer) clearTimeout(timer); fn(value); };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        if (timeoutMs > 0) timer = setTimeout(() => { pending.delete(id); reject(new JsonRpcError(-32001, `${method} timed out`)); }, timeoutMs);
        try {
          if (!write({ id, method, params }, beforeWrite)) throw new JsonRpcError(-32000, "connection closed");
        } catch (error) {
          pending.delete(id);
          settle(reject)(error);
        }
      });
    },
    notify(method, params = {}) { return write({ method, params }); },
    close() { close("connection closed"); },
    get closed() { return closed; },
  };
}
