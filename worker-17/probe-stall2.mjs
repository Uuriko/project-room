#!/usr/bin/env node
// Precise stall test: route that READS the body + stalled sender.
// Measures exactly when/how the server reacts. Compares plain node vs app.
import { connect } from "node:net";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
mkdirSync(join(HERE, ".tmp"), { recursive: true });
console.log("node", process.version);

function stall(port, path, origin, label, clientMs = 22000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} resolve({ label, outcome: "client-timeout", ms: Date.now() - t0 }); }, clientMs);
    timer.unref();
    sock.on("connect", () => {
      let h = `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\nConnection: close\r\nContent-Type: application/json\r\n`;
      if (origin) h += `Origin: ${origin}\r\n`;
      h += `\r\nhello`; // 5 of 100 bytes, then stall forever
      sock.write(h);
    });
    sock.on("data", c => { buf = Buffer.concat([buf, c]); });
    sock.on("close", () => { clearTimeout(timer); resolve({ label, outcome: "closed", ms: Date.now() - t0, firstLine: buf.toString("latin1").split("\r\n")[0] || "(no data)" }); });
    sock.on("error", e => { clearTimeout(timer); resolve({ label, outcome: "error", ms: Date.now() - t0, e: String(e) }); });
  });
}

// A: plain node server whose handler reads the body, requestTimeout=3000
const plain = http.createServer((req, res) => {
  let n = 0;
  req.on("data", c => { n += c.length; });
  req.on("end", () => res.end("got " + n));
});
plain.requestTimeout = 3000;
await new Promise(r => plain.listen(0, "127.0.0.1", r));
console.log("A plain-node body-reading route, requestTimeout=3000 ->", await stall(plain.address().port, "/x", null, "plain"));
plain.close();

// B: app server, preview route (reads body), requestTimeout=15000
const { RoomStore } = await import(`${ROOT}/server/store.mjs`);
const { createRoomServer } = await import(`${ROOT}/server/http.mjs`);
const { initialRoom } = await import(`${ROOT}/server/bootstrap.mjs`);
const dir = mkdtempSync(join(HERE, ".tmp", "probedb-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("commons"));
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const aport = server.address().port;
const origin = `http://127.0.0.1:${aport}`;
console.log("B app /api/invitations/preview, requestTimeout=15000 ->", await stall(aport, "/api/invitations/preview", origin, "app"));
server.close();
process.exit(0);
