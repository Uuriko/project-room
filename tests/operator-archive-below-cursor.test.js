// Operator archive below the backfill cursor (research r68): a room whose
// messages table is parked behind its head can still shed old history the
// table holds, so the projection cap is not hostage to the integrity job.
// Only rows at or below the cursor move, never a message a later event names,
// and the result still certifies once the backfill catches up.
import { describe, test, before as beforeSuite, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { archivedMessageRow } from "../server/messages-store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const TOKEN = "operator-archive-below-cursor-token-0123456789";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const KEEP = 100;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-op-archive-cursor-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock, bodiesAtRest: true });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const send = (type, data) => { clock += 10_000; return store.command(owner, "commons", { id: randomUUID(), type, data }); };
  const post = (n, prefix = "m") => { for (let i = 0; i < n; i++) send(T.MESSAGE_POSTED, { messageId: `${prefix}-${i}`, body: `cursor fixture ${prefix} ${i} `.padEnd(120, "x") }); };
  const catchUp = () => { for (let i = 0; i < 40; i++) if (store.backfillMessages({ limit: 1000 }).done) break; };
  // The shape muse-room has on prod: the table published at an older head,
  // a block row parking the room, and the head moving on without it.
  const park = () => {
    const cursor = store.db.prepare("SELECT applied_seq, applied_event_id FROM messages_backfill_cursor WHERE room_id='commons'").get();
    store.db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at, last_diagnosed_at)
      VALUES ('commons', ?, ?, 'fixture park', ?, ?, ?)`).run(cursor.applied_seq + 1, "fixture-event", store.room("commons").sequence ?? cursor.applied_seq + 1, new Date(clock).toISOString(), new Date(clock).toISOString());
    return cursor.applied_seq;
  };
  const unpark = () => store.db.prepare("DELETE FROM messages_backfill_blocks WHERE room_id='commons'").run();
  const call = async data => {
    const response = await fetch(`${origin}/api/operator/archive`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Operator ${TOKEN}` },
      body: JSON.stringify(data)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, body: json };
  };
  const bytes = () => store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='commons'").get().n;
  const ids = () => new Set((store.room("commons").state.messages ?? []).map(message => message.id));
  const seqOf = id => store.db.prepare("SELECT seq FROM messages WHERE room_id='commons' AND message_id=?").get(id)?.seq ?? null;
  const actions = () => store.db.prepare("SELECT action, result, counts_json FROM operator_actions ORDER BY at, rowid").all();
  return { store, send, post, catchUp, park, unpark, call, bytes, ids, seqOf, actions };
}

const REQUEST = { roomId: "commons", keepNewest: KEEP, reason: "projection cap relief while parked", belowCursor: true };

describe("operator archive below the backfill cursor", { concurrency: false }, () => {
  beforeSuite(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  test("a parked room archives only rows at or below its cursor, frees bytes, and certifies once unparked", async t => {
    const f = await serve(t);
    f.post(KEEP + 60);
    f.catchUp();
    const cursorSeq = f.park();
    f.post(30, "late");
    assert.equal(f.store.archiveMessages("commons", { keepNewest: KEEP }).reason, "messages_table_not_certified", "the head-certified path refuses a parked room");
    const plan = await f.call(REQUEST);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.cursorSeq, cursorSeq);
    assert.ok(plan.body.archived >= 50, `archived ${plan.body.archived}`);
    assert.ok(plan.body.throughSeq <= cursorSeq, `throughSeq ${plan.body.throughSeq} <= cursor ${cursorSeq}`);
    assert.equal(f.store.room("commons").state.messagesArchive, undefined, "a dry run moves nothing");
    const before = f.bytes();
    const original = f.store.room("commons").state.messages.find(message => message.id === "m-0");
    const done = await f.call({ ...REQUEST, dryRun: false, expect: plan.body.expect });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(f.bytes() < before, `projection ${before} -> ${f.bytes()}`);
    const kept = f.ids();
    for (let i = 0; i < 30; i++) assert.ok(kept.has(`late-${i}`), `late-${i} (after the cursor) stays`);
    assert.ok(!kept.has("m-0"), "the oldest message moved");
    assert.equal(archivedMessageRow(f.store.db, "commons", "m-0")?.body, original.body, "the moved message reads back from the table");
    const audit = f.actions().at(-1);
    assert.equal(audit.action, "messages_archive");
    assert.equal(JSON.parse(audit.counts_json).belowCursor, true);
    f.post(1, "after-archive");
    assert.ok(f.ids().has("after-archive-0"), "posting continues");
    f.unpark();
    f.catchUp();
    assert.equal(f.store.checkMessagesParity({ roomId: "commons" }).ok, true, "replay after the park lifts equals the archived projection");
  });

  test("an old message a later event names stays, and the archive still certifies", async t => {
    const f = await serve(t);
    f.post(KEEP + 60);
    f.catchUp();
    f.park();
    f.send(T.MESSAGE_EDITED, { messageId: "m-1", body: "edited after the cursor".padEnd(120, "y"), expectedMessageRevision: 0 });
    f.send(T.MESSAGE_PINNED, { messageId: "m-2" });
    const plan = await f.call(REQUEST);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.ok(plan.body.expect.archived > 0);
    const done = await f.call({ ...REQUEST, dryRun: false, expect: plan.body.expect });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.touchedKept >= 1, JSON.stringify(done.body));
    const kept = f.ids();
    assert.ok(kept.has("m-1"), "the edited message stays in the projection");
    assert.ok(kept.has("m-2"), "the pinned message stays in the projection");
    assert.ok(!kept.has("m-0"), "an untouched neighbour moved");
    f.unpark();
    f.catchUp();
    assert.equal(f.store.checkMessagesParity({ roomId: "commons" }).ok, true);
  });

  test("without a usable cursor nothing moves, and the flag is checked", async t => {
    const f = await serve(t);
    f.post(KEEP + 20);
    const refused = await f.call(REQUEST);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "archive_not_ready");
    assert.match(refused.body.error.message, /messages_cursor_unusable/);
    assert.equal(f.store.room("commons").state.messagesArchive, undefined);
    assert.equal(f.actions().at(-1).result, "refused");
    const bad = await f.call({ ...REQUEST, belowCursor: "yes" });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, "invalid_archive_request");
  });

  test("a caught-up room archives the same with or without the flag", async t => {
    const f = await serve(t);
    f.post(KEEP + 40);
    f.catchUp();
    assert.equal(f.store.checkMessagesParity({ roomId: "commons" }).ok, true);
    const plain = f.store.archiveMessages("commons", { keepNewest: KEEP, dryRun: true });
    const flagged = f.store.archiveMessages("commons", { keepNewest: KEEP, dryRun: true, belowCursor: true });
    assert.equal(plain.ok, true);
    assert.deepEqual({ archived: flagged.archived, throughSeq: flagged.throughSeq, freedBytes: flagged.freedBytes },
      { archived: plain.archived, throughSeq: plain.throughSeq, freedBytes: plain.freedBytes });
  });

  test("below-cursor planning never invokes global backfill or changes its evidence", async t => {
    const f = await serve(t);
    f.post(KEEP + 60);
    f.catchUp();
    f.park();
    f.post(30, "later");
    const evidence = () => ({
      cursor: f.store.db.prepare("SELECT * FROM messages_backfill_cursor ORDER BY room_id").all(),
      blocks: f.store.db.prepare("SELECT * FROM messages_backfill_blocks ORDER BY room_id").all(),
      snapshots: f.store.db.prepare("SELECT * FROM message_replay_snapshots ORDER BY room_id").all()
    });
    const before = evidence();
    f.store.backfillMessages = () => { throw new Error("global backfill must not execute"); };
    const plan = await f.call(REQUEST);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.deepEqual(evidence(), before);
    const stale = await f.call({ ...REQUEST, dryRun: false,
      expect: { ...plan.body.expect, archived: plan.body.archived + 1 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "plan_changed");
    assert.deepEqual(evidence(), before);
    assert.equal(f.store.room("commons").state.messagesArchive, undefined);
  });

  test("a mismatched moving row refuses both planning and execution without publishing a marker", async t => {
    const f = await serve(t);
    f.post(KEEP + 60);
    f.catchUp();
    f.park();
    f.post(30, "later");
    const before = f.bytes();
    f.store.db.prepare("UPDATE messages SET body='synthetic wrong body' WHERE room_id='commons' AND message_id='m-0'").run();
    for (const data of [REQUEST, { ...REQUEST, dryRun: false, expect: { archived: 90, throughSeq: 92 } }]) {
      const refusal = await f.call(data);
      assert.equal(refusal.status, 409, JSON.stringify(refusal.body));
      assert.match(refusal.body.error.message, /archive_spot_check_failed/);
      assert.equal(f.bytes(), before);
      assert.equal(f.store.room("commons").state.messagesArchive, undefined);
      assert.ok(f.ids().has("m-0"));
    }
  });

  test("an invalid cursor event anchor refuses below-cursor compaction", async t => {
    const f = await serve(t);
    f.post(KEEP + 60);
    f.catchUp();
    f.park();
    f.post(30, "later");
    f.store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='not-the-stored-event' WHERE room_id='commons'").run();
    const before = f.bytes();
    const refusal = await f.call(REQUEST);
    assert.equal(refusal.status, 409, JSON.stringify(refusal.body));
    assert.match(refusal.body.error.message, /messages_cursor_unusable/);
    assert.equal(f.bytes(), before);
    assert.equal(f.store.room("commons").state.messagesArchive, undefined);
  });
});
