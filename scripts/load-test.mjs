// Load test: N concurrent agents doing a realistic work loop against the room server.
// Usage: node scripts/load-test.mjs [agents=25] [iterations=5]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const AGENTS = Number(process.argv[2] ?? 25);
const ITERS = Number(process.argv[3] ?? 5);

const directory = mkdtempSync(join(tmpdir(), "room-load-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const ownerKey = store.issueAccessKey("commons", "owner");
const agents = [];
for (let i = 0; i < AGENTS; i++) {
  const memberId = `load-agent-${i}`;
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: `load-task-${i}`, title: `Load task ${i}`, definitionOfDone: "Claimed and completed under load",
    accountableMemberId: memberId, mode: "read" } });
  agents.push({ memberId, key: store.issueAccessKey("commons", memberId) });
}
const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const latencies = [];
const errors = new Map();
let ops = 0;
const time = async label => {
  const start = performance.now();
  try { const r = await label(); latencies.push(performance.now() - start); ops++; return r; }
  catch (e) { latencies.push(performance.now() - start); errors.set(e.code ?? e.message, (errors.get(e.code ?? e.message) ?? 0) + 1); }
};

async function agentLoop({ memberId, key }) {
  const c = new RoomAgentClient({ version: 1, origin, roomId: "commons", memberId, token: key });
  for (let i = 0; i < ITERS; i++) {
    await time(() => c.presence());
    await time(() => c.command({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: `load ping ${i} from ${memberId}` } }));
    await time(() => c.claimSession(`load-task-${Math.floor(Math.random() * AGENTS)}`)).catch(() => {});
    await time(() => c.changes(0, 20));
    await time(() => c.capabilities());
  }
}

const wallStart = performance.now();
await Promise.all(agents.map(agentLoop));
const wallMs = performance.now() - wallStart;
latencies.sort((a, b) => a - b);
const pct = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1);
console.log(JSON.stringify({
  agents: AGENTS, iterations: ITERS, wallMs: Math.round(wallMs),
  ops, opsPerSec: Math.round(ops / (wallMs / 1000)),
  latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pct(1) },
  errors: Object.fromEntries(errors),
}, null, 2));
server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close(); rmSync(directory, { recursive: true, force: true });
