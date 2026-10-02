import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { DEFAULT_CHANNEL_ID } from "../src/events.js";

const EVENTS = 200_000;
const COLD_START_CPU_BUDGET_MS = 500;

function captureInfo(fn) {
  const lines = [];
  const original = console.info;
  console.info = (...args) => { lines.push(args.map(String).join(" ")); };
  try { return { lines, value: fn() }; }
  finally { console.info = original; }
}

test("cold start on a large message log stays within the CPU budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-cold-start-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  try {
    store.initialize(initialRoom());
    const body = JSON.stringify({
      type: "message.posted", roomId: "commons", actorId: "owner",
      data: { messageId: "m", body: "Synthetic audit event for the cold-start measurement, long enough to resemble a real chat line." }
    });
    store.transaction(() => {
      const insert = store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)");
      for (let sequence = 3; sequence <= EVENTS; sequence += 1) insert.run("commons", sequence, `e${sequence}`, body);
      store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(EVENTS, "commons");
    });
  } finally { store.close(); }
  try {
    const { lines, value: reopened } = captureInfo(() => new RoomStore(filename));
    try {
      const record = JSON.parse(lines.find(line => line.includes('"event":"room.cold_start"')));
      assert.equal(record.failed, undefined);
      assert.equal(record.rooms, 1);
      assert.equal(record.events, EVENTS);
      assert.ok(record.projectionBytes > 0);
      assert.equal(typeof record.heapBytes, "number");
      assert.ok(record.durationMs >= 0);
      assert.ok(Number.isFinite(record.cpuMs), "cold start must record CPU time");
      assert.ok(record.cpuMs < COLD_START_CPU_BUDGET_MS, `cold start used ${record.cpuMs}ms CPU`);
      assert.equal(reopened.room("commons").state.channels[DEFAULT_CHANNEL_ID].id, DEFAULT_CHANNEL_ID);
    } finally { reopened.close(); }
    const { lines: deferredLines, value: deferred } = captureInfo(() => new RoomStore(filename, { integrity: "deferred" }));
    try {
      const record = JSON.parse(deferredLines.find(line => line.includes('"event":"room.cold_start"')));
      assert.equal(record.integrity, "deferred");
      assert.equal(record.integrityMatch, 0);
      assert.equal(record.events, undefined);
      assert.equal(record.sequences, EVENTS);
      assert.ok(record.projectionBytes > 0);
      assert.ok(record.cpuMs < COLD_START_CPU_BUDGET_MS, `deferred cold start used ${record.cpuMs}ms CPU`);
      assert.equal(deferred.room("commons").state.channels[DEFAULT_CHANNEL_ID].id, DEFAULT_CHANNEL_ID);
    } finally { deferred.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("reopen still repairs a legacy channel and a missing proposer", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-cold-repair-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  try {
    store.initialize(initialRoom());
    const legacy = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
    delete legacy.channels;
    legacy.workItems = { "legacy-job": { id: "legacy-job", title: "Legacy", state: "proposed" } };
    const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(legacy));
    store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)").run(
      "commons", sequence + 1, "legacy-propose",
      JSON.stringify({ id: "legacy-propose", type: "work.proposed", roomId: "commons", actorId: "owner", data: { workItemId: "legacy-job" } })
    );
  } finally { store.close(); }
  try {
    const reopened = new RoomStore(filename);
    try {
      const state = reopened.room("commons").state;
      assert.equal(state.channels[DEFAULT_CHANNEL_ID].id, DEFAULT_CHANNEL_ID);
      assert.equal(state.workItems["legacy-job"].proposedById, "owner");
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("deferred open leaves a legacy projection until the integrity job repairs it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-cold-deferred-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  try {
    store.initialize(initialRoom());
    const legacy = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
    delete legacy.channels;
    legacy.workItems = { "legacy-job": { id: "legacy-job", title: "Legacy", state: "proposed" } };
    const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
    store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(legacy));
    store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)").run(
      "commons", sequence + 1, "legacy-propose",
      JSON.stringify({ id: "legacy-propose", type: "work.proposed", roomId: "commons", actorId: "owner", data: { workItemId: "legacy-job" } })
    );
  } finally { store.close(); }
  try {
    const reopened = new RoomStore(filename, { integrity: "deferred" });
    try {
      const before = reopened.room("commons").state;
      assert.equal(before.channels, undefined);
      assert.equal(before.workItems["legacy-job"].proposedById, undefined);
      const stalled = await reopened.verifyRoomIntegrity({ deadline: 0, yieldBetween: async () => {} });
      assert.equal(stalled.budgetExceeded, 1);
      assert.equal(stalled.verified, 0);
      assert.equal(reopened.room("commons").state.channels, undefined);
      let yields = 0;
      const repaired = await reopened.verifyRoomIntegrity({ yieldBetween: async () => { yields += 1; } });
      assert.equal(repaired.verified, 1);
      assert.ok(yields >= 1);
      const after = reopened.room("commons").state;
      assert.equal(after.channels[DEFAULT_CHANNEL_ID].id, DEFAULT_CHANNEL_ID);
      assert.equal(after.workItems["legacy-job"].proposedById, "owner");
      const again = await reopened.verifyRoomIntegrity({ yieldBetween: async () => { yields += 1; } });
      assert.equal(again.matched, 1);
      assert.equal(again.skipped, 1);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
