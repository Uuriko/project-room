// #1905 repro benchmark: 16 concurrent writers x 25 plain MESSAGE_POSTED
// posts over HTTP, measuring posts/sec + p50/p95/p99. Mirrors the issue's
// baseline scenario ("16 concurrent writers x 25 posts").
// Usage: TMPDIR=./.bench node scripts/bench-1905.mjs [writers] [postsPerWriter]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
const origin = `http://127.0.0.1:${server.address().port}`;

async function writer({ memberId, key }) {
  const latencies = [];
  let ok = 0, failed = 0;
  for (let i = 0; i < POSTS; i++) {
    const start = performance.now();
    try {
      const r = await fetch(`${origin}/api/rooms/${ROOM}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ id: randomUUID(), type: T.MESSAGE_POSTED,
          data: { messageId: randomUUID(), body: `bench ping ${i} from ${memberId}` } }),
      });
      if (!r.ok) failed++; else ok++;
      await r.text();
    } catch { failed++; }
    latencies.push(performance.now() - start);
  }
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
