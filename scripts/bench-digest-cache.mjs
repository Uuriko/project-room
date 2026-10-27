// Local synthetic benchmark. No network or production credentials.
// node scripts/bench-digest-cache.mjs [message-count=2500] [samples=30]
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const messages = Number(process.argv[2] ?? 2500), samples = Number(process.argv[3] ?? 30);
if (!Number.isSafeInteger(messages) || messages < 1 || messages > 100000
  || !Number.isSafeInteger(samples) || samples < 5 || samples > 1000) throw new Error("Invalid benchmark size");
const store = new RoomStore(":memory:", { verifyProjectionCache: false });
try {
  store.initialize(initialRoom());
  const token = store.issueAccessKey("commons", "owner");
  store.roomFlood = { consume: () => false, refund() {} };
  const post = () => store.command(token, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body: "Synthetic room evidence. ".repeat(36) } });
  for (let i = 0; i < messages; i++) post();
  let coldReads = 0;
  const read = store._readProjection.bind(store);
  store._readProjection = (...args) => { coldReads++; return read(...args); };
  const measure = (name, fn) => {
    for (let i = 0; i < 5; i++) fn();
    const before = coldReads, durations = [];
    for (let i = 0; i < samples; i++) { const start = performance.now(); fn(); durations.push(performance.now() - start); }
    const sorted = [...durations].sort((a, b) => a - b);
    return { name, samples, p50Ms: sorted[Math.floor(samples * .5)], p95Ms: sorted[Math.min(samples - 1, Math.floor(samples * .95))],
      coldReads: coldReads - before, samplesMs: durations };
  };
  const digest = () => store.roomDigest(token, "commons", { since: store.headSequence("commons") - 20 });
  const heartbeat = () => store.transaction(() => store.agentHeartbeats.heartbeat({ agentId: "ai_digestbench", hostId: "bench", mode: "pull-only" }));
  const results = [
    measure("warm-digest-last20", digest),
    measure("heartbeat-then-digest-last20", () => { heartbeat(); digest(); }),
    measure("heartbeat-then-room", () => { heartbeat(); store.room("commons"); }),
    measure("post-message", post)
  ];
  console.log(JSON.stringify({ schema: 1, node: process.version, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    messages, projectionBytes: Buffer.byteLength(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("commons").projection),
    caveat: "Synthetic in-memory Node timings, including auth/projection work; not production latency. Post samples grow the room.", results }));
} finally { store.close(); }
