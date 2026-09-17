import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCollector } from "../src/growth-collector.js";
import { defineEvent } from "../src/growth-events.js";
import {
  GROWTH_SNAPSHOT_VERSION,
  snapshot,
  restore,
  loadCollector,
  loadFromFile,
  saveToFile
} from "../src/growth-persistence.js";

const at = minute => `2026-09-15T16:${String(minute).padStart(2, "0")}:00.000Z`;
const human = { id: "zoe", kind: "human" };
const agent = { id: "agent-7", kind: "agent" };

const messageSent = (over = {}) =>
  defineEvent("message.sent", { actor: human, source: "web", occurredAt: at(0), fields: { roomId: "r1", messageId: "m1" }, ...over });
const reactionAdded = minute =>
  defineEvent("reaction.added", { actor: agent, source: "web", occurredAt: at(minute), fields: { roomId: "r1", messageId: "m1", reaction: "thumbsup" } });

const filled = (count, capacity) => {
  const c = createCollector({ maxEvents: capacity ?? 10 });
  for (let i = 0; i < count; i += 1) {
    c.record(messageSent({ occurredAt: at(i), fields: { roomId: "r1", messageId: `m${i}` } }));
  }
  return c;
};

test("C11 round-trip preserves events, capacity, and stats", () => {
  const c = filled(3);
  const json = snapshot(c);
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, GROWTH_SNAPSHOT_VERSION);
  assert.equal(parsed.capacity, 10);
  assert.equal(parsed.events.length, 3);
  assert.ok(typeof parsed.exportedAt === "string");
  const restored = loadCollector(json);
  const s = restored.stats();
  assert.equal(s.capacity, 10);
  assert.equal(s.total, 3);
  assert.equal(s.recorded, 3);
  assert.equal(s.dropped, 0);
  assert.deepEqual(s.perType, { "message.sent": 3 });
  assert.equal(s.oldest, at(0));
  assert.equal(s.newest, at(2));
  // Oldest-first replay order keeps the same envelope sequence.
  const envelopes = restored.query({ limit: 10 }).map(e => e.fields.messageId);
  assert.deepEqual(envelopes, ["m2", "m1", "m0"]); // newest-first from query
});

test("C11 snapshot of an empty collector round-trips", () => {
  const restored = loadCollector(snapshot(createCollector({ maxEvents: 5 })));
  const s = restored.stats();
  assert.equal(s.total, 0);
  assert.equal(s.recorded, 0);
  assert.equal(s.capacity, 5);
});

test("C11 restore throws on corrupt inputs, never partial", () => {
  assert.throws(() => restore("not json"), /not valid JSON/);
  assert.throws(() => restore("[]"), /must be a JSON object/);
  assert.throws(() => restore(JSON.stringify({ version: 2, capacity: 10, events: [] })), /unsupported snapshot version/);
  assert.throws(() => restore(JSON.stringify({ version: 1, capacity: 0, events: [] })), /capacity must be a positive integer/);
  assert.throws(() => restore(JSON.stringify({ version: 1, capacity: 10, events: {} })), /events must be an array/);
  // An envelope that fails C1 validation fails the whole restore.
  const bad = JSON.stringify({ version: 1, capacity: 10, events: [{ type: "message.sent", fields: {} }] });
  assert.throws(() => restore(bad), /failed validation/);
  // Sensitive fields are refused at the door.
  const sneaky = JSON.stringify({
    version: 1, capacity: 10,
    events: [{ ...messageSent(), fields: { roomId: "r1", messageId: "m1", password: "x" } }]
  });
  assert.throws(() => restore(sneaky), /failed validation/);
});

test("C11 restore enforces capacity, keeping the newest and counting drops", () => {
  const c = filled(8, 5); // capacity 5, 3 dropped live
  const json = snapshot(c); // snapshot holds the 5 stored
  const parsed = JSON.parse(json);
  // Tamper: stuff more events than the capacity into the file.
  const stuffed = JSON.stringify({ ...parsed, events: [...parsed.events, ...parsed.events, ...parsed.events] });
  const restored = restore(stuffed);
  assert.equal(restored.droppedOldest, 10);
  assert.equal(restored.events.length, 5);
  const collector = loadCollector(stuffed);
  const s = collector.stats();
  assert.equal(s.total, 5);
  assert.equal(s.recorded, 5);
  assert.equal(s.dropped, 0);
});

test("C11 snapshot throws on an invalid collector", () => {
  assert.throws(() => snapshot(null), /must be a C2 collector/);
  assert.throws(() => snapshot({}), /must be a C2 collector/);
});

test("C11 file round-trip and missing-file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "growth-c11-"));
  try {
    const file = join(dir, "nested", "growth-snapshot.json");
    const c = filled(4);
    c.record(reactionAdded(9));
    assert.equal(saveToFile(file, c), file);
    const { restored, collector, exportedAt } = loadFromFile(file);
    assert.equal(restored, true);
    assert.ok(typeof exportedAt === "string");
    const s = collector.stats();
    assert.equal(s.total, 5);
    assert.deepEqual(s.perType, { "message.sent": 4, "reaction.added": 1 });

    const missing = loadFromFile(join(dir, "nope.json"));
    assert.equal(missing.restored, false);
    assert.equal(missing.collector.stats().total, 0);
    assert.equal(missing.exportedAt, null);

    // Corrupt file throws a clear error for the server to catch.
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{oops");
    assert.throws(() => loadFromFile(corrupt), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C11 saveToFile throws on an invalid collector", () => {
  assert.throws(() => saveToFile("/tmp/x.json", null), /must be a C2 collector/);
});
