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
import { archivedMessageRow } from "../server/messages-store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { RELIEF_REASON, relieveProjections } from "../server/store-relief.mjs";
import { jobByName } from "../server/jobs.mjs";

const KEEP = 100;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-store-relief-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock, bodiesAtRest: true });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => { clock += 10_000; return store.command(owner, "commons", { id: randomUUID(), type, data }); };
  const post = (n, prefix = "m") => { for (let i = 0; i < n; i++) send(T.MESSAGE_POSTED, { messageId: `${prefix}-${i}`, body: `relief ${prefix} ${i} `.padEnd(400, "x") }); };
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
  return { store, post, catchUp, bytes, ids, actions, park };
}

test("a room past the line is archived through the door, audited, and counted without ids", t => {
  const f = fixture(t);
  f.post(KEEP + 200);
  f.catchUp();
  const before = f.bytes();
  const result = relieveProjections(f.store, { limitBytes: before - 1, keepNewest: KEEP });
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
  const result = relieveProjections(f.store, { limitBytes: before - 1, keepNewest: KEEP });
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
  assert.deepEqual(relieveProjections(f.store, { limitBytes: before + 1, keepNewest: KEEP }), { attempted: 0, relieved: 0, freedBytes: 0, refused: 0 });
  assert.equal(f.bytes(), before);
  assert.equal(f.actions().length, 0);
  assert.equal(relieveProjections({ readOnly: true, db: f.store.db }, { limitBytes: 0 }).attempted, 0);
});

test("a refusal is counted, not thrown, and nothing moves", t => {
  const f = fixture(t);
  f.post(KEEP + 20);
  const before = f.bytes();
  const refuse = () => { const error = new Error("no"); error.code = "archive_not_ready"; throw error; };
  const result = relieveProjections(f.store, { limitBytes: before - 1, keepNewest: KEEP, archive: refuse });
  assert.deepEqual(result, { attempted: 1, relieved: 0, freedBytes: 0, refused: 1 });
  assert.equal(f.bytes(), before);
});

test("the store-growth job still fails by name when relief cannot clear the breach", async t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE rooms SET projection = ?").run("x".repeat(3_600_000));
  const summary = await jobByName("store-growth").run(f.store, {});
  assert.equal(summary.errors, 1);
  assert.equal(summary.failureDetail?.code, "store_growth_limit");
  assert.equal(summary.relief?.attempted, 1);
  assert.equal(summary.relief?.relieved, 0);
});
