import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Parsed room() reads stay frozen and current. A hit must not re-parse a
// multi-megabyte projection, and a rooms write at the same sequence must
// not keep serving the previous parse.
const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-projection-cache-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file, options);
  let projectionReads = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql === "SELECT projection FROM rooms WHERE id=?") {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { projectionReads += 1; return get(...args); };
    }
    return statement;
  };
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, file, projectionReads: () => projectionReads };
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test("room() is frozen, stable for one sequence, and a failed command leaves messages unchanged", t => {
  const { store, owner } = fixture(t);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "kept", body: "kept" }));
  const first = store.room("commons");
  const second = store.room("commons");
  assert.equal(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.state), true);
  assert.equal(Object.isFrozen(first.state.messages), true);
  assert.throws(() => { first.state.room.title = "mutated"; });
  assert.throws(() => store.command(owner, "commons", command(T.MESSAGE_POSTED, { body: " " })), /body/);
  const afterRefusal = store.room("commons");
  assert.equal(afterRefusal.state.messages.at(-1).body, "kept");
  assert.equal(afterRefusal.state.messages.length, first.state.messages.length);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "visible", body: "visible after commit" }));
  assert.equal(store.room("commons").state.messages.at(-1).body, "visible after commit");
});

test("a same-sequence rooms rewrite is visible on the next room() read", t => {
  const { store } = fixture(t);
  const seen = store.room("commons");
  const rewritten = structuredClone(seen.state);
  rewritten.room.title = "Same sequence rewrite";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(rewritten), "commons");
  const next = store.room("commons");
  assert.equal(next.sequence, seen.sequence);
  assert.equal(next.state.room.title, "Same sequence rewrite");
  assert.notEqual(next, seen);
});

test("a warm read of a 4 MiB room is much faster than parsing that projection", t => {
  const { store } = fixture(t);
  store.initialize(initialRoom("bulky"));
  const bulky = structuredClone(store.room("bulky").state);
  bulky.messages = [{ id: "bulk", authorId: "owner", body: "x".repeat(4 * 1024 * 1024), createdAt: "2026-10-02T00:00:00.000Z" }];
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(bulky), "bulky");
  const blob = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("bulky").projection;
  assert.ok(Buffer.byteLength(blob) >= 4 * 1024 * 1024);
  const parseSamples = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    JSON.parse(blob);
    parseSamples.push(performance.now() - started);
  }
  store.room("bulky");
  const warmSamples = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const hit = store.room("bulky");
    warmSamples.push(performance.now() - started);
    assert.equal(hit.state.messages[0].body.length, 4 * 1024 * 1024);
  }
  const parseMs = median(parseSamples), warmMs = median(warmSamples);
  t.diagnostic(`4 MiB projection: parse median ${parseMs.toFixed(2)} ms, warm room() median ${warmMs.toFixed(2)} ms`);
  assert.ok(warmMs < parseMs / 3, `warm median ${warmMs} ms, parse median ${parseMs} ms`);
});

test("evicting cached rooms still returns each room's own projection", t => {
  const { store } = fixture(t);
  for (let i = 0; i < 40; i++) store.initialize(initialRoom(`cache-room-${i}`));
  for (let i = 0; i < 40; i++) assert.equal(store.room(`cache-room-${i}`).state.room.id, `cache-room-${i}`);
  for (let i = 0; i < 40; i++) assert.equal(store.room(`cache-room-${i}`).state.room.id, `cache-room-${i}`);
  assert.equal(store.room("commons").state.room.id, "commons");
});

// Authoring gate: protect commit-visible snapshots without a cold projection
// read, with an independent fresh connection as the storage oracle. Existing
// cache tests warm room() only after commit, so pass despite that cold read.
// Rollback/savepoint and same-sequence rewrites protect distinct lifecycles.
for (const bodiesAtRest of [false, true]) {
  test(`committed write-through reads equal cold storage without rereading projection (bodies=${bodiesAtRest})`, t => {
    const f = fixture(t, { bodiesAtRest });
    const steps = [
      [T.MESSAGE_POSTED, { messageId: "long", body: "patch:" + "x".repeat(870) }],
      [T.MESSAGE_EDITED, { messageId: "long", body: "edited:" + "y".repeat(900), expectedMessageRevision: 0 }],
      [T.MESSAGE_POSTED, { messageId: "reply", body: "short", replyToId: "long" }],
      [T.CHANNEL_CREATED, { channelId: "side", name: "side-quest" }],
      [T.CHANNEL_RENAMED, { channelId: "side", name: "side-track" }],
      [T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" }],
      [T.NOTIFICATION_PREFERENCES_SET, { preferences: { mentions: "all" } }],
      [T.MESSAGE_PINNED, { messageId: "long" }],
      [T.MESSAGE_UNPINNED, { messageId: "long" }],
      [T.WORK_PROPOSED, { workItemId: "cache-work", title: "Cache contract", definitionOfDone: "Cold equality", accountableMemberId: "owner", mode: "read" }],
    ];
    for (const [type, data] of steps) {
      f.store.command(f.owner, "commons", command(type, data));
      const before = f.projectionReads();
      const warm = f.store.room("commons");
      assert.equal(f.projectionReads(), before, `${type}: first committed read must not decode projection`);
      assert.ok(Object.isFrozen(warm.state));
      const cold = new RoomStore(f.file, { readOnly: true });
      try { assert.deepEqual(warm, cold.room("commons"), type); }
      finally { cold.close(); }
    }
    // Deletion emits extra redaction events and must invalidate any candidate
    // from the earlier message.deleted UPDATE in the same transaction.
    f.store.command(f.owner, "commons", command(T.MESSAGE_DELETED, { messageId: "long", expectedMessageRevision: 1, reason: "remove" }));
    const cold = new RoomStore(f.file, { readOnly: true });
    try { assert.deepEqual(f.store.room("commons"), cold.room("commons")); }
    finally { cold.close(); }
    assert.equal(f.store.room("commons").state.messages.find(m => m.id === "long").body, null);
  });
}

test("outer rollback and isolated rollback never publish uncommitted write-through state", t => {
  const { store, owner } = fixture(t, { bodiesAtRest: true });
  const post = id => store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: id, body: id }));
  const start = store.room("commons");
  assert.throws(() => store.transaction(() => {
    post("outer-rollback");
    store.room("commons");
    throw new Error("abort outer");
  }), /abort outer/);
  assert.deepEqual(store.room("commons"), start);
  store.transaction(() => {
    post("before-savepoint");
    assert.throws(() => store.transaction(() => {
      post("isolated-rollback");
      store.room("commons");
      throw new Error("abort isolated");
    }, { isolated: true }), /abort isolated/);
    assert.equal(store.room("commons").state.messages.some(m => m.id === "isolated-rollback"), false);
    post("after-savepoint");
    store.transaction(() => post("isolated-success"), { isolated: true });
  });
  const ids = store.room("commons").state.messages.map(m => m.id);
  assert.ok(ids.includes("before-savepoint") && ids.includes("after-savepoint") && ids.includes("isolated-success"));
  assert.equal(ids.includes("isolated-rollback") || ids.includes("outer-rollback"), false);
});

test("an unregistered same-sequence rewrite after a command invalidates its pending candidate", t => {
  const { store, owner } = fixture(t);
  store.transaction(() => {
    store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "committed", body: "hello" }));
    store.db.prepare("UPDATE rooms SET projection=json_set(projection, '$.room.title', ?) WHERE id=?").run("Later rewrite", "commons");
  });
  assert.equal(store.room("commons").state.room.title, "Later rewrite");
});


test("JSON-unstable command output falls back to the exact stored representation", t => {
  const { store, owner, file } = fixture(t);
  // -0 is accepted as a zero-cent allowance, but JSON stores it as +0.
  store.command(owner, "commons", command(T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: -0, periodDays: 30 }));
  const cold = new RoomStore(file, { readOnly: true });
  try { assert.deepEqual(store.room("commons"), cold.room("commons")); }
  finally { cold.close(); }
  assert.equal(Object.is(store.room("commons").state.room.spendAllowance.allowanceCents, -0), false);
});

test("failed COMMIT discards candidates even when the command itself succeeded", t => {
  const { store, owner } = fixture(t);
  const before = store.room("commons");
  store.db.exec("CREATE TABLE cache_commit_fault (room_id TEXT REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED)");
  assert.throws(() => store.transaction(() => {
    store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "not-committed", body: "roll back" }));
    store.db.prepare("INSERT INTO cache_commit_fault VALUES(?)").run("missing-room");
  }), /FOREIGN KEY/);
  assert.deepEqual(store.room("commons"), before);
});

test("debug verification cold-checks every hit and refuses same-sequence storage divergence", t => {
  const f = fixture(t, { verifyProjectionCache: true, bodiesAtRest: true });
  f.store.command(f.owner, "commons", command(T.MESSAGE_POSTED, { messageId: "debug", body: "x".repeat(870) }));
  const reads = f.projectionReads();
  const warm = f.store.room("commons");
  assert.equal(f.projectionReads(), reads + 1);
  assert.equal(f.store.room("commons"), warm);
  assert.equal(f.projectionReads(), reads + 2);
  const other = new RoomStore(f.file);
  try { other.db.prepare("UPDATE rooms SET projection=json_set(projection, '$.room.title', ?) WHERE id=?").run("External rewrite", "commons"); }
  finally { other.close(); }
  assert.throws(() => f.store.room("commons"), /Projection cache differs from storage/);
  assert.equal(f.store.room("commons").state.room.title, "External rewrite");
});

test("a command after body recovery caches the same restored text as a cold read", t => {
  const f = fixture(t, { bodiesAtRest: true });
  f.store.command(f.owner, "commons", command(T.MESSAGE_POSTED, { messageId: "recover", body: "restore:" + "x".repeat(870) }));
  f.store.db.prepare("DELETE FROM projection_bodies WHERE room_id=?").run("commons");
  f.store.db.prepare("UPDATE rooms SET projection=projection WHERE id=?").run("commons");
  f.store.command(f.owner, "commons", command(T.MESSAGE_POSTED, { messageId: "after-recovery", body: "next" }));
  const reads = f.projectionReads();
  const warm = f.store.room("commons");
  assert.equal(f.projectionReads(), reads);
  const cold = new RoomStore(f.file, { readOnly: true });
  try { assert.deepEqual(warm, cold.room("commons")); }
  finally { cold.close(); }
  assert.equal(warm.state.messages.find(m => m.id === "recover").body, "restore:" + "x".repeat(870));
});
