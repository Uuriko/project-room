import { createServer } from "node:http";
import { acceptUpgrade } from "../lib/ws.mjs";
import { ENROLL_TTL_MS } from "../lib/protocol.mjs";

// In-repo stand-in for RELAY-0. Speaks the enroll HTTP route and the
// outbound machine socket from machine/PROTOCOL.md.
export function startFakeRelay() {
  const codes = new Map();
  const sockets = [];
  const hellos = [];
  const results = [];
  let silent = false;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || new URL(req.url, "http://127.0.0.1").pathname !== "/v0/enroll") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
      const record = codes.get(body.code);
      const now = Date.now();
      if (!record) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "code_invalid" }));
        return;
      }
      if (record.used || now > record.expiresAt) {
        res.writeHead(410, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: record.used ? "code_used" : "code_expired" }));
        return;
      }
      record.used = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(record.response));
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const auth = req.headers.authorization ?? "";
    const expected = [...codes.values()].map(record => record.response.machineToken);
    if (!expected.includes(auth.replace(/^Bearer /, ""))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const link = acceptUpgrade(req, socket, head, {
      onText: text => {
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (message.type === "hello") hellos.push(message);
        if (message.type === "result") results.push(message);
      },
    });
    if (link) sockets.push(link);
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        http: `http://127.0.0.1:${port}`,
        ws: `ws://127.0.0.1:${port}/v0/machines/link`,
        hellos,
        results,
        sockets: () => sockets,
        silence() { silent = true; },
        mint(code, response, { ttlMs = ENROLL_TTL_MS } = {}) {
          codes.set(code, { used: false, expiresAt: Date.now() + ttlMs, response });
        },
        send(message) {
          if (silent) return;
          const link = sockets.at(-1);
          link?.send(JSON.stringify(message));
        },
        async close() {
          for (const link of sockets) link.close();
          await new Promise(done => server.close(done));
        },
      });
    });
  });
}
