// #1905 benchmark v2: raw TCP keep-alive + TCP_NODELAY, eliminating the
// Nagle/delayed-ACK artifact that pollutes fetch-based loopback benchmarks.
// 16 writers x 25 POSTs, closed-loop, measures true server throughput.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ROOM = "commons";
const WRITERS = Number(process.argv[2] ?? 16);
const POSTS = Number(process.argv[3] ?? 25);

const directory = mkdtempSync(join(tmpdir(), "bench1905-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const ownerKey = store.issueAccessKey(ROOM, "owner");
const agents = [];
for (let i = 0; i < WRITERS; i++) {
  const memberId = `bench-${i}`;
  store.command(ownerKey, ROOM, { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
  agents.push({ memberId, key: store.issueAccessKey(ROOM, memberId) });
}
const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function postOnce(sock, key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body } });
    const req = `POST /api/rooms/${ROOM}/commands HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      `Authorization: Bearer ${key}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(payload)}\r\nConnection: keep-alive\r\n\r\n${payload}`;
    const t0 = performance.now();
    let buf = "";
    const onData = chunk => {
      buf += chunk.toString("latin1");
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const m = /content-length:\s*(\d+)/i.exec(buf);
      const len = m ? parseInt(m[1], 10) : 0;
      if (buf.length >= headEnd + 4 + len) {
        sock.off("data", onData);
        const status = parseInt(buf.slice(9, 12), 10);
        resolve({ status, ms: performance.now() - t0 });
      }
    };
    sock.on("data", onData);
    sock.once("error", reject);
    sock.write(req);
  });
}

async function writer({ key }) {
  const sock = connect(port, "127.0.0.1");
  sock.setNoDelay(true);
  await new Promise((r, j) => { sock.once("connect", r); sock.once("error", j); });
  const latencies = [];
  let ok = 0, failed = 0;
  for (let i = 0; i < POSTS; i++) {
    try {
      const { status, ms } = await postOnce(sock, key, `bench ${i}`);
      latencies.push(ms);
      if (status === 200 || status === 201) ok++; else failed++;
    } catch { failed++; }
  }
  sock.destroy();
  return { latencies, ok, failed };
}

const wallStart = performance.now();
const results = await Promise.all(agents.map(writer));
const wallMs = performance.now() - wallStart;
const all = results.flatMap(r => r.latencies).sort((a, b) => a - b);
const ok = results.reduce((n, r) => n + r.ok, 0);
const failed = results.reduce((n, r) => n + r.failed, 0);
const pct = p => all[Math.min(all.length - 1, Math.floor(all.length * p))];
console.log(JSON.stringify({
  writers: WRITERS, postsPerWriter: POSTS, total: all.length, ok, failed,
  wallMs: Math.round(wallMs),
  postsPerSec: +(all.length / (wallMs / 1000)).toFixed(2),
  latencyMs: { p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1), max: +pct(1).toFixed(1) },
}, null, 2));

server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close(); rmSync(directory, { recursive: true, force: true });
