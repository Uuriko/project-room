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
  const store = new RoomStore(join(directory, "room.sqlite"), options);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner };
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

for (const platform of ['node', 'durable']) test(`${platform}: cursor commits retain projection cache without retaining revoked authorization`, async t => {
  let store, owner;
  if (platform === 'node') ({ store, owner } = fixture(t));
  else {
    const { DurableDatabase, durableStorage } = await import('../cloudflare/storage.mjs');
    const { createDoContext } = await import('./helpers/do-storage-emulator.mjs');
    const ctx = createDoContext();
    store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
    store.initialize(initialRoom()); owner = store.issueAccessKey('commons', 'owner');
    t.after(() => { store.close(); ctx.storage.close(); });
  }
  const warm = store.room('commons');
  let projectionReads = 0;
  const statement = store._roomProjectionStmt, get = statement.get.bind(statement);
  statement.get = (...args) => { projectionReads++; return get(...args); };
  for (let i = 0; i < 5; i++) {
    store.markCaughtUp(owner, 'commons', warm.sequence);
    assert.equal(store.snapshot(owner, 'commons').state.messages, warm.state.messages);
  }
  assert.equal(projectionReads, 0, 'side-table commits must not reload the entire projection');
  const replacement = store.issueAccessKey('commons', 'owner');
  store.revokeStaleRoomKeys('commons', 'owner', replacement);
  assert.throws(() => store.snapshot(owner, 'commons'), /access|key|Unauthorized|credential/i);
  assert.equal(store.snapshot(replacement, 'commons').sequence, warm.sequence);
});

test('prepared and quoted room writes invalidate before a read, including RETURNING and rollback', t => {
  const { store } = fixture(t);
  const prepared = store.db.prepare('UPDATE OR REPLACE main."rooms" SET projection=? WHERE id=? RETURNING sequence');
  const warm = store.room('commons'), next = structuredClone(warm.state);
  next.room.title = 'Committed rewrite';
  store.transaction(() => {
    prepared.get(JSON.stringify(next), 'commons');
    assert.equal(store.room('commons').state.room.title, next.room.title);
  });
  assert.equal(store.room('commons').state.room.title, next.room.title);
  assert.throws(() => store.transaction(() => {
    const reverted = structuredClone(next); reverted.room.title = 'Uncommitted rewrite';
    prepared.all(JSON.stringify(reverted), 'commons');
    assert.equal(store.room('commons').state.room.title, reverted.room.title);
    throw new Error('rollback fixture');
  }), /rollback fixture/);
  assert.equal(store.room('commons').state.room.title, next.room.title);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => {
      store.db.exec(`UPDATE rooms SET projection=json_set(projection,'$.room.title','Isolated rewrite') WHERE id='commons'`);
      assert.equal(store.room('commons').state.room.title, 'Isolated rewrite');
      throw new Error('isolated rollback');
    }, { isolated: true }), /isolated rollback/);
    assert.equal(store.room('commons').state.room.title, next.room.title);
  });
});


test("body-at-rest mutations invalidate hydration and recover current text from the ledger", t => {
  const { store, owner } = fixture(t, { bodiesAtRest: true });
  const body = "recoverable text ".repeat(500);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "body-dependency", body }));
  const warm = store.room("commons");
  assert.ok(store.db.prepare("SELECT count(*) AS n FROM projection_bodies").get().n > 0);
  store.transaction(() => store.db.prepare("DELETE FROM main.\"projection_bodies\" WHERE room_id=?").run("commons"));
  const recovered = store.room("commons");
  assert.notEqual(recovered, warm);
  assert.equal(recovered.state.messages.find(message => message.id === "body-dependency").body, body);
});
