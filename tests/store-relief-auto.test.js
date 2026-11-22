// Default automatic projection relief: the line sits at 80% of the
// projection cap, a refused room backs off per window, a Node store gets a
// verified local recovery point (it has no R2/KV backup), and a write
// refused by a full projection asks the scheduler for an early tick.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PILOT_LIMITS, RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { archivedMessageRow } from "../server/messages-store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { RELIEF_BACKOFF_BASE_MS, RELIEF_REASON, reliefLineBytes, relieveProjections, relieveProjectionsIncrementally } from "../server/store-relief.mjs";
import { RECOVERY_DIRECTORY_NAME, localRecoveryPoint } from "../server/node-recovery-point.mjs";
import { HOUR_MS, NODE_RELIEF_KICK_MS, STORE_GROWTH_LIMITS, jobByName, startNodeScheduler } from "../server/jobs.mjs";

const KEEP = 100;
const RECOVERY = Object.freeze({ key: "fixture-backup", target: "kv", ageDays: 0 });

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-relief-auto-"));
  let clock = Date.parse("2026-11-22T12:00:00Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock, bodiesAtRest: true, ...options });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const post = (n, prefix = "m") => {
    for (let i = 0; i < n; i++) {
      clock += 10_000;
      store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `${prefix}-${i}`, body: `auto ${prefix} ${i} `.padEnd(400, "x") } });
    }
  };
  const bytes = () => store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='commons'").get().n;
  const ids = () => new Set((store.room("commons").state.messages ?? []).map(message => message.id));
  const actions = () => store.db.prepare("SELECT action, result, reason FROM operator_actions ORDER BY at, rowid").all();
  return { directory, store, post, bytes, ids, actions, clock: () => clock, advance: ms => { clock += ms; } };
}

test("the relief line is 80% of the projection cap, or the escalation line when lower", () => {
  const cap = PILOT_LIMITS.projectionBytes;
  assert.equal(reliefLineBytes({ projectionByteLimit: cap }), Math.floor(cap * 0.8));
  assert.equal(reliefLineBytes({ projectionByteLimit: cap }, STORE_GROWTH_LIMITS.maxProjectionBytes), Math.min(Math.floor(cap * 0.8), STORE_GROWTH_LIMITS.maxProjectionBytes));
  const legacy = PILOT_LIMITS.legacyProjectionCeilingBytes;
  assert.equal(reliefLineBytes({ projectionByteLimit: legacy }), Math.floor(legacy * 0.8));
  assert.ok(reliefLineBytes({ projectionByteLimit: legacy }) < legacy, "relief starts before writes fail");
  assert.equal(reliefLineBytes({}), null);
});

test("a refused room backs off per window and is never retried in a loop", t => {
  const f = fixture(t);
  f.post(KEEP + 20);
  const limitBytes = f.bytes() - 1;
  let calls = 0;
  const refuse = () => { calls += 1; const error = new Error("no"); error.code = "messages_not_certified"; throw error; };
  const backoff = new Map();
  let now = f.clock();
  const run = archive => relieveProjections(f.store, { limitBytes, keepNewest: KEEP, recovery: RECOVERY, archive, backoff, now: () => now });
  assert.deepEqual(run(refuse), { attempted: 1, relieved: 0, freedBytes: 0, refused: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(run(refuse), { attempted: 0, relieved: 0, freedBytes: 0, refused: 0, deferred: 1 }, "same window: skipped");
  assert.equal(calls, 1);
  now += RELIEF_BACKOFF_BASE_MS;
  assert.equal(run(refuse).attempted, 1, "next window: one more attempt");
  assert.equal(backoff.get("commons").failures, 2);
  now += RELIEF_BACKOFF_BASE_MS;
  assert.equal(run(refuse).deferred, 1, "the wait doubles after a second refusal");
  now += RELIEF_BACKOFF_BASE_MS;
  // The real door succeeds once the room certifies; success clears the wait.
  for (let i = 0; i < 40; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  const done = run(undefined);
  assert.equal(done.relieved, 1, JSON.stringify(done));
  assert.equal(backoff.has("commons"), false);
  assert.ok(!f.ids().has("m-0") && archivedMessageRow(f.store.db, "commons", "m-0")?.body, "archived, still readable");
});

test("a Node store gets a verified local recovery point, reused for a day", async t => {
  const f = fixture(t);
  f.post(5);
  let copies = 0;
  const copy = async (...args) => { copies += 1; const { backup } = await import("node:sqlite"); return backup(...args); };
  let now = f.clock();
  const point = await localRecoveryPoint(f.store, { now: () => now, copy });
  assert.equal(point?.target, "local");
  assert.equal(point.ageDays, 0);
  const dir = join(f.directory, RECOVERY_DIRECTORY_NAME);
  const file = join(dir, point.key);
  assert.ok(existsSync(file) && existsSync(`${file}.verified.json`));
  assert.equal(statSync(file).mode & 0o777, 0o600, "the copy holds what the store holds: owner-only");
  now += HOUR_MS;
  assert.equal((await localRecoveryPoint(f.store, { now: () => now, copy }))?.key, point.key, "reused within a day");
  assert.equal(copies, 1);
  now += 25 * HOUR_MS;
  const next = await localRecoveryPoint(f.store, { now: () => now, copy });
  assert.notEqual(next.key, point.key);
  assert.equal(copies, 2);
  assert.deepEqual(readdirSync(dir).sort(), [next.key, `${next.key}.verified.json`], "older copies are pruned");
});

test("a local recovery point fails closed: bad copy, opt-out, in-memory, read-only", async t => {
  const f = fixture(t);
  f.post(3);
  const junk = async (_db, path) => { writeFileSync(path, "not a database"); };
  assert.equal(await localRecoveryPoint(f.store, { copy: junk }), null);
  const dir = join(f.directory, RECOVERY_DIRECTORY_NAME);
  assert.deepEqual(readdirSync(dir), [], "nothing unverified is left behind");
  const empty = async (_db, path) => { const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(path); db.exec("CREATE TABLE rooms(id); CREATE TABLE events(id); CREATE TABLE messages(id)"); db.close(); };
  assert.equal(await localRecoveryPoint(f.store, { copy: empty }), null, "a copy missing rows is refused");
  assert.equal(await localRecoveryPoint(f.store, { env: { ROOM_RELIEF_LOCAL_BACKUP: "0" } }), null);
  assert.equal(await localRecoveryPoint({ readOnly: true, db: f.store.db }), null);
  assert.equal(await localRecoveryPoint({ db: { location: () => null } }), null);
});

test("on Node, relief archives behind the local copy, audited, and keeps every event", async t => {
  const f = fixture(t);
  f.post(KEEP + 150);
  const events = f.store.db.prepare("SELECT count(*) AS n FROM events").get().n;
  const before = f.bytes();
  const recovery = await localRecoveryPoint(f.store);
  assert.ok(recovery, "local recovery point");
  const result = await relieveProjectionsIncrementally(f.store, { limitBytes: before - 1, keepNewest: KEEP, recovery, eventCap: 4000, yieldWork: async () => {} });
  assert.equal(result.relieved, 1, JSON.stringify(result));
  assert.ok(f.bytes() < before);
  assert.deepEqual(f.actions().map(row => [row.action, row.result, row.reason]), [
    ["messages_archive_plan", "ok", RELIEF_REASON], ["messages_archive", "ok", RELIEF_REASON]]);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events").get().n, events, "the event log is untouched");
  assert.ok(archivedMessageRow(f.store.db, "commons", "m-0")?.body);
  assert.ok(f.ids().has(`m-${KEEP + 149}`));
});

test("the store-growth job backs off a room it could not relieve", async t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE rooms SET projection = ?").run("x".repeat(STORE_GROWTH_LIMITS.maxProjectionBytes + 100_000));
  const ctx = { recoveryPoint: () => RECOVERY, reliefBackoff: new Map(), now: () => f.clock() };
  const first = await jobByName("store-growth").run(f.store, ctx);
  assert.equal(first.reliefAttempted, 1);
  assert.equal(first.reliefRefused, 1);
  assert.equal(first.failureDetail?.code, "store_growth_limit", "a breach relief could not clear still pages");
  const second = await jobByName("store-growth").run(f.store, ctx);
  assert.equal(second.reliefAttempted, 0);
  assert.equal(second.reliefDeferred, 1);
});

test("the Node scheduler hands its recovery point to the store-growth job", async t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE rooms SET projection = ?").run("x".repeat(STORE_GROWTH_LIMITS.maxProjectionBytes + 100_000));
  let asked = 0;
  const scheduler = startNodeScheduler({ store: f.store, env: { GROWTH_WATCH_INTERVAL_MS: "0" }, tickMs: 0, now: () => f.clock(), recoveryPoint: () => { asked += 1; return null; } });
  t.after(() => scheduler.stop());
  const outcome = (await scheduler.runOnce()).find(o => o.job === "store-growth");
  assert.equal(asked, 1);
  assert.equal(outcome?.result?.reliefBackupMissing, 1, "no recovery point: nothing archived, and the summary says why");
});

test("a write refused by a full projection asks the Node scheduler for one early store-growth tick", async t => {
  const f = fixture(t);
  let clock = f.clock();
  const scheduler = startNodeScheduler({ store: f.store, env: { GROWTH_WATCH_INTERVAL_MS: "0", ROOM_RELIEF_LOCAL_BACKUP: "0" }, tickMs: 0, now: () => clock });
  t.after(() => scheduler.stop());
  await scheduler.runOnce();
  const ranAt = () => scheduler.jobHealth().find(job => job.name === "store-growth").lastRunAt;
  const first = ranAt();
  assert.equal(typeof first, "string");
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  clock += 60_000;
  assert.equal(f.store.projectionExceedsWriteLimit("x".repeat(f.store.projectionByteLimit + 1)), true, "the refusal is unchanged");
  await settle();
  const kicked = ranAt();
  assert.notEqual(kicked, first, "store-growth ran early");
  clock += 60_000;
  f.store.projectionExceedsWriteLimit("x".repeat(f.store.projectionByteLimit + 1));
  await settle();
  assert.equal(ranAt(), kicked, "a second refusal inside the window does not kick again");
  clock += NODE_RELIEF_KICK_MS;
  f.store.projectionExceedsWriteLimit("x".repeat(f.store.projectionByteLimit + 1));
  await settle();
  assert.notEqual(ranAt(), kicked, "the next window may kick once more");
  assert.equal(f.store.projectionExceedsWriteLimit("small"), false);
});
