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

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-projection-cache-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
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
