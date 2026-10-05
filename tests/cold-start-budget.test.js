import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { DEFAULT_CHANNEL_ID } from "../src/events.js";
import { createRecoveryFixture } from "../scripts/recovery-fixture.mjs";
import { seedRecoveryCoverage } from "../scripts/recovery-coverage.mjs";
import { applicationTables } from "../server/writer-fence.mjs";

// Empty in the recovery fixture: cron tables, and update marks that exist only
// after a member reads, finishes, or clears an item. Same exceptions as the recovery audit.
const EMPTY_UNTIL_CRON = new Set([
  "membership_delegation_pending",
  "room_access_auto_approve",
  "integrity_snapshot",
  "integrity_job_cursor",
  "integrity_room_state",
  // A public room page stays empty until an owner opts in. The backfill
  // cursor is written by cron. Same exceptions as the recovery audit.
  "public_rooms",
  "public_read_model_backfill",
  "private_update_marks",
  "private_update_commands",
  "messages_backfill_cursor",
  "agent_wants_work",
  // Spend grants and authorizations exist only after an owner issues a grant.
  "spend_grant_terms",
  "spend_authorizations"
]);

const EVENTS = 200_000;
const COLD_START_CPU_BUDGET_MS = 500;

function captureInfo(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  try { return { lines, value: fn() }; }
  finally { console.error = original; }
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
      assert.equal(record.integrityMatch, undefined);
      assert.equal(record.phases.checksum.rowsRead, 0);
      assert.equal(record.events, undefined);
      assert.equal(record.sequences, EVENTS);
      assert.ok(record.projectionBytes > 0);
      assert.ok(record.cpuMs < COLD_START_CPU_BUDGET_MS, `deferred cold start used ${record.cpuMs}ms CPU`);
      assert.equal(deferred.room("commons").state.channels[DEFAULT_CHANNEL_ID].id, DEFAULT_CHANNEL_ID);
    } finally { deferred.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("deferred cold start on a production-shaped store stays within the budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-cold-shaped-"));
  const filename = join(directory, "room.sqlite");
  const fixture = createRecoveryFixture(filename);
  try {
    try {
      await seedRecoveryCoverage(fixture);
      const counted = [];
      for (const table of applicationTables) {
        if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`unexpected table name ${table}`);
        const rows = fixture.store.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
        if (EMPTY_UNTIL_CRON.has(table)) assert.equal(rows, 0, `${table} stays empty until the cron`);
        else assert.ok(rows > 0, `${table} has production-shaped rows`);
        counted.push(table);
      }
      assert.equal(counted.length, applicationTables.length);
      const start = fixture.store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
      const body = JSON.stringify({
        type: "message.posted", roomId: "commons", actorId: "owner",
        data: { messageId: "m", body: "Synthetic audit event for the cold-start measurement, long enough to resemble a real chat line." }
      });
      fixture.store.transaction(() => {
        const insert = fixture.store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)");
        for (let offset = 1; offset <= EVENTS; offset += 1) insert.run("commons", start + offset, `shaped${offset}`, body);
        fixture.store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(start + EVENTS);
      });
    } finally { fixture.store.close(); }
    const { lines, value: deferred } = captureInfo(() => new RoomStore(filename, { integrity: "deferred" }));
    try {
      const record = JSON.parse(lines.find(line => line.includes('"event":"room.cold_start"')));
      assert.equal(record.integrity, "deferred");
      assert.equal(record.phases.checksum.rowsRead, 0);
      assert.equal(record.events, undefined);
      assert.ok(record.rooms >= 2);
      assert.ok(record.sequences > EVENTS);
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
