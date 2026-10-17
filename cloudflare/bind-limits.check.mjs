// Durable Object SQL allows 100 bound parameters per statement; Node's
// SQLite allows far more, so these paths pass the Node suite and fail on
// prod. Each case drives the real Worker storage adapter (local workerd via
// Miniflare) past 100 values, the shape r38 found in the patrol look-back:
// - restore-from-backup: the credentials self-reference look-up binds every
//   distinct parent_hash in a 500-row batch (one per browser session's access
//   key), so a backup with >100 sessions could not be restored on the Worker;
// - the owner's agent fleet view binds one sequence per agent that has ever
//   acted, so a room with 100+ such agents 500s;
// - REST wake acks bind every signal id twice-over with no cap, so a host
//   acking 95+ ids got a 500 instead of an ack.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonStream } from "../server/room-export.mjs";
import { writeKvBackup } from "./room-backup.mjs";

// Repo root from this file, so the check runs from cloudflare/ (CI) or the root.
const source = process.env.ROOM_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(source, "cloudflare/package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");

const fixture = `
import entry, { ProjectRoom } from "./room.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { fleetRows } from "../server/agent-fleet.mjs";
import { event, EVENT_TYPES as T } from "../src/events.js";
export class BindLimitProbeRoom extends ProjectRoom {
  async fetch(request) {
    const url = new URL(request.url), store = this.store, db = store.db;
    const run = fn => { try { return Response.json({ ok: true, value: fn() }); } catch (error) { return Response.json({ ok: false, error: String(error?.message ?? error) }); } };
    if (url.pathname === "/__probe/binds") {
      const n = Number(url.searchParams.get("n"));
      return run(() => db.prepare("SELECT ? IN (" + Array(n).fill("?").join(",") + ") AS x").get(...Array(n + 1).fill(1)).x);
    }
    if (url.pathname === "/__probe/state") {
      return Response.json({
        rooms: db.prepare("SELECT count(*) AS n FROM rooms").get().n,
        sessions: db.prepare("SELECT count(*) AS n FROM credentials WHERE parent_hash IS NOT NULL").get().n,
      });
    }
    if (url.pathname === "/__probe/fleet") {
      const agents = Number(url.searchParams.get("agents")), roomId = "fleet-room";
      const added = [], posts = [];
      for (let i = 0; i < agents; i++) {
        const memberId = "agent-" + String(i).padStart(3, "0");
        added.push(event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, data: { memberId, displayName: "Agent " + i, kind: "agent", permissions: [] } }));
        posts.push(event({ type: T.MESSAGE_POSTED, actorId: memberId, roomId, data: { messageId: "m-" + i, body: "hello " + i } }));
      }
      store.initialize([...initialRoom(roomId), ...added, ...posts]);
      return run(() => fleetRows(store, roomId, store.room(roomId)).length);
    }
    if (url.pathname === "/__probe/ack") {
      const count = Number(url.searchParams.get("ids")), agentId = "ai_probe_agent";
      return run(() => {
        const hb = store.agentHeartbeats;
        hb.heartbeat({ agentId, hostId: "probe-host", mode: "pull-only" });
        const ids = Array.from({ length: count }, (_, i) => hb.enqueueWake({ agentId, kind: "mention", messageId: "m-" + i }).signal.signalId);
        return hb.ackWakes({ agentId, signalIds: ids, door: "rest" }).acknowledged.length;
      });
    }
    return super.fetch(request);
  }
}
export default entry;
`;

const bundled = await build({ stdin: { contents: fixture, resolveDir: join(source, "cloudflare"), sourcefile: "bind-limits-fixture.mjs" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"] });

async function worker(t) {
  const directory = await mkdtemp(join(tmpdir(), "bind-limits-"));
  const origin = "https://room.example.test", token = randomUUID();
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "BindLimitProbeRoom", useSQLite: true } },
    durableObjectsPersist: join(directory, "persist"),
    kvNamespaces: ["ROOM_BACKUPS_KV"], kvPersist: join(directory, "kv"),
    bindings: { ROOM_ORIGIN: origin, ROOM_BACKUP_TOKEN: token },
  });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const get = async path => { const response = await mf.dispatchFetch(origin + path); assert.equal(response.status, 200, path); return response.json(); };
  return { mf, origin, token, directory, get };
}

test("the Worker's SQL rejects a 101-value statement (the limit these cases cover)", { timeout: 120000 }, async t => {
  const { get } = await worker(t);
  assert.deepEqual(await get("/__probe/binds?n=99"), { ok: true, value: 1 });
  const over = await get("/__probe/binds?n=100");
  assert.equal(over.ok, false);
  assert.match(over.error, /too many SQL variables/);
});

test("restore-from-backup on the Worker survives 150 browser sessions with distinct parent keys", { timeout: 120000 }, async t => {
  const { mf, origin, token, directory, get } = await worker(t);
  const seed = new RoomStore(join(directory, "seed.sqlite"));
  t.after(() => seed.close());
  seed.initialize(initialRoom());
  for (let i = 0; i < 150; i++) seed.createSession(seed.issueAccessKey("commons", "owner"));
  assert.equal(seed.db.prepare("SELECT count(DISTINCT parent_hash) AS n FROM credentials WHERE parent_hash IS NOT NULL").get().n, 150);
  const kv = await mf.getKVNamespace("ROOM_BACKUPS_KV");
  const key = "room-backups/2026-10-17.ndjson";
  await writeKvBackup(kv, key, exportNdjsonStream(seed.db), { partBytes: 16384 });
  const restored = await mf.dispatchFetch(`${origin}/api/operator/restore-from-backup`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ key }),
  });
  const result = await restored.json();
  assert.equal(restored.status, 200, JSON.stringify(result));
  assert.equal(result.verified, true);
  assert.deepEqual(await get("/__probe/state"), { rooms: 1, sessions: 150 });
});

test("the agent fleet view on the Worker lists 120 agents that have all posted", { timeout: 120000 }, async t => {
  const { get } = await worker(t);
  assert.deepEqual(await get("/__probe/fleet?agents=120"), { ok: true, value: 120 });
});

test("a REST wake ack of 120 ids on the Worker answers instead of failing in SQL", { timeout: 120000 }, async t => {
  const { get } = await worker(t);
  assert.deepEqual(await get("/__probe/ack?ids=120"), { ok: true, value: 120 });
});
