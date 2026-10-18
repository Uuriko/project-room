// One benchmark run: copy a seeded fixture, open it with one tree's code and
// measure. compare.mjs runs this many times in fresh processes, alternating
// base and head. Prints one JSON object on stdout.
//
//   node --expose-gc scripts/bench/room-scale.mjs --root <tree> --fixture <dir> [--writes 200] [--replay-cap 4000]
//
// Each metric is measured on its own and reads null when the tree lacks the
// API it needs (older commits), so a comparison never crashes on drift.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTree, messageBody, rng } from "./fixture.mjs";
import { median } from "./stats.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve(arg("root", "."));
const fixture = resolve(arg("fixture"));
const WRITES = Number(arg("writes", 200));
const REPLAY_CAP = Number(arg("replay-cap", 4000));

const meta = JSON.parse(readFileSync(join(fixture, "meta.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "room-bench-run-"));
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(join(fixture, `room.sqlite${suffix}`))) copyFileSync(join(fixture, `room.sqlite${suffix}`), join(work, `room.sqlite${suffix}`));
}
const { RoomStore, T, at } = await loadTree(root);
let clock = meta.clock;
const store = new RoomStore(join(work, "room.sqlite"), { now: () => clock, bodiesAtRest: Boolean(meta.bodiesAtRest) });
const room = meta.roomId, owner = meta.keys[0];
const ms = fn => { const t = performance.now(); fn(); return performance.now() - t; };
const gc = () => globalThis.gc?.();
const safe = fn => { try { return fn(); } catch { return null; } };
const round = (v, d = 2) => v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(d);
const result = { size: meta.size, sequence: meta.sequence, fixtureFailures: meta.failed ?? 0 };

// Writes on top of the seeded room: what one more message costs at this size.
store.room(room); // warm the cache the way a live room is warm
const random = rng(meta.seed + 1), times = [];
let failed = 0;
for (let i = 0; i < WRITES; i++) {
  clock += 15000;
  const command = { id: `bench-${i}`, type: T.MESSAGE_POSTED, data: { messageId: `bench-${i}`, body: messageBody(random, meta.size + i) } };
  const t = performance.now();
  try {
    store.command(meta.keys[i % meta.keys.length], room, command);
    times.push(performance.now() - t);
  } catch { failed++; }
}
const sorted = [...times].sort((a, b) => a - b);
result.writeP50Ms = round(median(times));
result.writeP95Ms = round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
result.writeFailures = failed;
result.writeAttempts = WRITES;
result.writeSuccesses = times.length;

gc();
const state = store.room(room).state;
result.storedProjectionMs = round(safe(() => typeof store.storedProjection === "function"
  ? median([0, 1, 2, 3, 4].map(() => ms(() => store.storedProjection(room, state)))) : null));
result.coldRoomMs = round(safe(() => typeof store._dropProjectionCache === "function"
  ? median([0, 1, 2, 3, 4].map(() => { store._dropProjectionCache(); return ms(() => store.room(room)); })) : null));
result.projectionKB = round(safe(() => store.db.prepare("SELECT length(projection) AS b FROM rooms WHERE id=?").get(room).b / 1024), 0);

gc();
let snapshotBytes = null;
result.snapshotBuildMs = round(safe(() => median([0, 1, 2].map(() => ms(() => { snapshotBytes = Buffer.byteLength(JSON.stringify(store.snapshot(owner, room))); })))));
result.snapshotKB = round(snapshotBytes === null ? null : snapshotBytes / 1024, 0);

// The same reads over HTTP, as a browser makes them: the full room and the
// recent window a client fetches first.
try {
  const { createRoomServer } = await at("server/http.mjs");
  const server = createRoomServer({ store });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async path => {
    const t = performance.now();
    const response = await fetch(origin + path, { headers: { authorization: `Bearer ${owner}` } });
    const bytes = (await response.arrayBuffer()).byteLength;
    return { ok: response.ok, bytes, ms: performance.now() - t };
  };
  for (const [key, path] of [["httpFull", `/api/rooms/${room}`], ["httpRecent", `/api/rooms/${room}?messages=recent`]]) {
    await get(path); // warm
    const samples = [];
    for (let i = 0; i < 5; i++) samples.push(await get(path));
    if (samples.every(s => s.ok)) {
      result[`${key}KB`] = round(samples[0].bytes / 1024, 1);
      result[`${key}Ms`] = round(median(samples.map(s => s.ms)));
    }
  }
  server.closeStreams?.(); server.closeAllConnections?.();
  await new Promise(done => server.close(done));
} catch { /* an older tree without the same server API: the HTTP metrics stay absent */ }

// Rebuilding the room from its log (recovery, account deletion, archive restore).
gc();
const head = safe(() => store.room(room).sequence);
result.replayMs = head !== null && head <= REPLAY_CAP && typeof store._replayRoom === "function"
  ? round(safe(() => ms(() => store._replayRoom(room, head))), 0) : null;

result.heapMB = round(process.memoryUsage().heapUsed / 1048576, 0);
store.close();
rmSync(work, { recursive: true, force: true });
process.stdout.write(JSON.stringify(result) + "\n");
// Timers left by server modules must not keep a finished run alive.
process.exit(0);
