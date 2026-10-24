// The store-growth job relieves a projection past the escalation line
// through the guarded operator archive door instead of only paging.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { archivedMessageRow, restoreArchivedMessages } from "../server/messages-store.mjs";
import { backupObjectKey, verifiedRecentBackup } from "../cloudflare/room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { RELIEF_REASON, relieveProjections } from "../server/store-relief.mjs";
import { jobByName } from "../server/jobs.mjs";
import { compactSummary } from "../cloudflare/job-heartbeat.mjs";

const KEEP = 100;
const RECOVERY = Object.freeze({ key: "fixture-backup", target: "kv", ageDays: 0 });

function fixture(t, { bodiesAtRest = true, pad = 400 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-store-relief-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock, bodiesAtRest });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => { clock += 10_000; return store.command(owner, "commons", { id: randomUUID(), type, data }); };
  const post = (n, prefix = "m") => { for (let i = 0; i < n; i++) send(T.MESSAGE_POSTED, { messageId: `${prefix}-${i}`, body: `relief ${prefix} ${i} `.padEnd(pad, "x") }); };
  const catchUp = () => { for (let i = 0; i < 40; i++) if (store.backfillMessages({ limit: 1000 }).done) break; };
  const bytes = () => store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='commons'").get().n;
  const ids = () => new Set((store.room("commons").state.messages ?? []).map(message => message.id));
  const actions = () => store.db.prepare("SELECT action, result, reason, counts_json FROM operator_actions ORDER BY at, rowid").all();
  const park = () => {
    const cursor = store.db.prepare("SELECT applied_seq FROM messages_backfill_cursor WHERE room_id='commons'").get();
    const at = new Date(clock).toISOString();
    store.db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at, last_diagnosed_at)
      VALUES ('commons', ?, 'fixture-event', 'fixture park', ?, ?, ?)`).run(cursor.applied_seq + 1, store.room("commons").sequence, at, at);
    return cursor.applied_seq;
  };
  return { store, send, post, catchUp, bytes, ids, actions, park };
}

test("a room past the line is archived through the door, audited, and counted without ids", t => {
  const f = fixture(t);
  f.post(KEEP + 200);
  f.catchUp();
  const before = f.bytes();
  const result = relieveProjections(f.store, { limitBytes: before - 1, keepNewest: KEEP, recovery: RECOVERY });
  assert.equal(result.attempted, 1);
  assert.equal(result.relieved, 1, JSON.stringify(result));
  assert.equal(result.refused, 0);
  assert.ok(result.freedBytes > 0 && f.bytes() < before, `projection ${before} -> ${f.bytes()}`);
  assert.ok(!f.ids().has("m-0"), "the oldest message moved");
  assert.ok(archivedMessageRow(f.store.db, "commons", "m-0")?.body, "the moved message reads back from the table");
  assert.ok(f.ids().has(`m-${KEEP + 199}`), "the newest message stays");
  const audit = f.actions();
  assert.deepEqual(audit.map(row => row.action), ["messages_archive_plan", "messages_archive"]);
  assert.ok(audit.every(row => row.reason === RELIEF_REASON && row.result === "ok"));
  assert.equal(JSON.stringify(result).includes("commons"), false, "the summary carries no room id");
  assert.equal(f.store.checkMessagesParity({ roomId: "commons" }).ok, true);
});

test("a parked room archives below its cursor only, and later messages stay", t => {
  const f = fixture(t);
  f.post(KEEP + 200);
  f.catchUp();
  f.park();
  f.post(30, "late");
  const before = f.bytes();
  const result = relieveProjections(f.store, { limitBytes: before - 1, keepNewest: KEEP, recovery: RECOVERY });
  assert.equal(result.relieved, 1, JSON.stringify(result));
  assert.ok(f.bytes() < before);
  for (let i = 0; i < 30; i++) assert.ok(f.ids().has(`late-${i}`), `late-${i} stays`);
  assert.equal(JSON.parse(f.actions().at(-1).counts_json).belowCursor, true);
});

test("rooms under the line are untouched and a read-only store does nothing", t => {
  const f = fixture(t);
  f.post(KEEP + 50);
  f.catchUp();
  const before = f.bytes();
  assert.deepEqual(relieveProjections(f.store, { limitBytes: before + 1, keepNewest: KEEP, recovery: RECOVERY }), { attempted: 0, relieved: 0, freedBytes: 0, refused: 0 });
  assert.equal(f.bytes(), before);
  assert.equal(f.actions().length, 0);
  assert.equal(relieveProjections({ readOnly: true, db: f.store.db }, { limitBytes: 0 }).attempted, 0);
});

test("a refusal is counted, not thrown, and nothing moves", t => {
  const f = fixture(t);
  f.post(KEEP + 20);
  const before = f.bytes();
  const refuse = () => { const error = new Error("no"); error.code = "archive_not_ready"; throw error; };
  const result = relieveProjections(f.store, { limitBytes: before - 1, keepNewest: KEEP, archive: refuse, recovery: RECOVERY });
  assert.deepEqual(result, { attempted: 1, relieved: 0, freedBytes: 0, refused: 1 });
  assert.equal(f.bytes(), before);
});

test("the store-growth job still fails by name when relief cannot clear the breach", async t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE rooms SET projection = ?").run("x".repeat(3_600_000));
  const summary = await jobByName("store-growth").run(f.store, { recoveryPoint: () => RECOVERY });
  assert.equal(summary.errors, 1);
  assert.equal(summary.failureDetail?.code, "store_growth_limit");
  assert.equal(summary.reliefAttempted, 1);
  assert.equal(summary.reliefRelieved, 0);
  assert.equal(summary.reliefRefused, 1);
});

// QA delta 17987: the automatic path archives only behind a verified recent
// backup, fails closed without one, and is rehearsed end to end on a
// production-shaped room (over the 3.5 MB alarm, default keepNewest 2000).

test("without a verified backup nothing moves and the summary says why", t => {
  const f = fixture(t);
  f.post(KEEP + 50);
  f.catchUp();
  const before = f.bytes();
  const result = relieveProjections(f.store, { limitBytes: before - 1, keepNewest: KEEP });
  assert.equal(result.backupMissing, 1);
  assert.equal(result.relieved, 0);
  assert.equal(result.freedBytes, 0);
  assert.equal(f.bytes(), before);
  assert.ok(f.ids().has("m-0"));
  assert.deepEqual(f.actions(), []);
});

test("the store-growth job fails closed when no backup is found", async t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE rooms SET projection = ?").run("x".repeat(3_600_000));
  const summary = await jobByName("store-growth").run(f.store, { recoveryPoint: () => null });
  assert.equal(summary.errors, 1);
  assert.equal(summary.failureDetail?.code, "store_growth_limit");
  assert.equal(summary.reliefBackupMissing, 1);
  assert.equal(summary.reliefAttempted, 0);
  assert.deepEqual(f.actions(), []);
  // The relief outcome survives the heartbeat's flat-number filter, so
  // /api/health/jobs shows why relief did or did not run.
  const published = compactSummary(summary);
  assert.equal(published.reliefBackupMissing, 1);
  assert.equal(published.reliefAttempted, 0);
  assert.equal(typeof published.maxProjectionBytes, "number");
});

test("verifiedRecentBackup accepts today or yesterday, and answers null otherwise", async () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const today = backupObjectKey(new Date(now));
  const yesterday = backupObjectKey(new Date(now - 86_400_000));
  const old = backupObjectKey(new Date(now - 2 * 86_400_000));
  const r2 = objects => ({ ROOM_BACKUPS: { put: async () => {}, head: async key => objects[key] ?? null } });
  const good = { size: 10, customMetadata: { sha256: "a".repeat(64), bytes: "10", backupVersion: "99" } };
  assert.deepEqual(await verifiedRecentBackup(r2({ [today]: good }), now), { key: today, target: "r2", ageDays: 0 });
  assert.deepEqual(await verifiedRecentBackup(r2({ [yesterday]: good }), now), { key: yesterday, target: "r2", ageDays: 1 });
  assert.equal(await verifiedRecentBackup(r2({ [old]: good }), now), null, "older than yesterday is not recent");
  assert.equal(await verifiedRecentBackup(r2({ [today]: { ...good, customMetadata: { ...good.customMetadata, sha256: "bad" } } }), now), null);
  assert.equal(await verifiedRecentBackup({ ROOM_BACKUPS: { put: async () => {}, head: async () => { throw new Error("down"); } } }, now), null);
  assert.equal(await verifiedRecentBackup({}, now), null);
  const kv = { ROOM_BACKUPS_KV: { put: async () => {}, get: async key => key === today ? JSON.stringify({ version: 99 }) : null } };
  assert.deepEqual(await verifiedRecentBackup(kv, now), { key: today, target: "kv", ageDays: 0 });
});

test("a production-shaped room over 3.5 MB drops below the alarm with keepNewest 2000, keeps pinned history, and restores", { timeout: 180_000 }, t => {
  const f = fixture(t, { bodiesAtRest: false, pad: 1500 });
  f.post(2300);
  f.send(T.MESSAGE_PINNED, { messageId: "m-0" });
  f.catchUp();
  const before = f.bytes();
  assert.ok(before > 3_500_000, `fixture is past the alarm: ${before}`);
  const result = relieveProjections(f.store, { limitBytes: 3_500_000, recovery: RECOVERY });
  assert.equal(result.relieved, 1, JSON.stringify(result));
  assert.ok(f.bytes() < 3_500_000, `projection ${before} -> ${f.bytes()}`);
  const kept = f.ids();
  assert.ok(kept.has("m-0"), "pinned history is retained");
  assert.ok(!kept.has("m-1"), "unpinned old history moved");
  assert.ok(kept.has("m-2299") && kept.has("m-300"), "the newest 2000 stay");
  assert.ok(archivedMessageRow(f.store.db, "commons", "m-1")?.body);
  assert.equal(f.store.checkMessagesParity({ roomId: "commons" }).ok, true);
  restoreArchivedMessages(f.store, "commons");
  const restored = f.ids();
  for (let i = 0; i < 2300; i++) assert.ok(restored.has(`m-${i}`), `m-${i} restored`);
});
