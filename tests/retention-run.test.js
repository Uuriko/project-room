import test from "node:test";
import assert from "node:assert/strict";
import { runRetention, scheduledRetentionTick, retentionDeletionAllowed, RetentionRunError } from "../server/retention-run.mjs";

const NOW = "2026-09-16T00:00:00Z";
const records = [
  { category: "events", timestamp: "2026-08-01T00:00:00Z", id: "old" },
  { category: "events", timestamp: "2026-09-10T00:00:00Z", id: "new" }
];
const events = [
  { id: "fresh", at: "2026-09-16T10:00:00Z", severity: "normal" },
  { id: "stale", at: "2025-01-01T10:00:00Z", severity: "normal" }
];

test("default retention run records the plan and deletes nothing", () => {
  const recorded = [];
  const deleted = [];
  const receipt = runRetention({ records, events, now: NOW, record: plan => recorded.push(plan), deleteRecord: item => deleted.push(item) });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.deleted, 0);
  assert.equal(receipt.liveStoreScanned, false);
  assert.equal(receipt.analytics.purgeCount, 1);
  assert.equal(receipt.audit.purge, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].deleted, 0);
  assert.deepEqual(deleted, []);
});

test("allowDeletion deletes only purge ids and records the plan first", () => {
  const order = [];
  const deleted = [];
  const receipt = runRetention({
    records, events, now: NOW, allowDeletion: true,
    record: () => order.push("record"),
    deleteRecord: item => { order.push("delete"); deleted.push(item); }
  });
  assert.equal(receipt.dryRun, false);
  assert.equal(receipt.deleted, 2);
  assert.deepEqual(order, ["record", "delete", "delete"]);
  assert.deepEqual(deleted, [
    { kind: "analytics", id: "old" },
    { kind: "audit", id: "stale" }
  ]);
});

test("the deletion flag is exact and a missing deleter deletes nothing", () => {
  assert.equal(retentionDeletionAllowed({ ROOM_RETENTION_ALLOW_DELETION: "1" }), true);
  assert.equal(retentionDeletionAllowed({ ROOM_RETENTION_ALLOW_DELETION: "true" }), false);
  assert.equal(retentionDeletionAllowed({ ROOM_RETENTION_ALLOW_DELETION: "yes" }), false);
  assert.equal(retentionDeletionAllowed({}), false);
  assert.equal(retentionDeletionAllowed(undefined), false);
  const deleted = [];
  const receipt = runRetention({ records, events, now: NOW, allowDeletion: true, deleteRecord: undefined, record: () => deleted.push("recorded") });
  assert.equal(receipt.deleted, 0);
  assert.equal(receipt.deletionBlocked, "no deleter");
  assert.deepEqual(deleted, ["recorded"]);
  assert.throws(() => runRetention({ allowDeletion: "1" }), error => error instanceof RetentionRunError && error.code === "invalid_retention_run");
});

test("scheduled tick records a dry-run and ignores a deleter even when the flag is set", () => {
  const recorded = [];
  const deleted = [];
  const receipt = scheduledRetentionTick({
    env: { ROOM_RETENTION_ALLOW_DELETION: "1" },
    now: NOW,
    record: plan => recorded.push(plan),
    deleteRecord: item => deleted.push(item)
  });
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.deleted, 0);
  assert.equal(receipt.deletionRequested, true);
  assert.equal(receipt.deletionApplied, false);
  assert.equal(receipt.ignoredDeleter, true);
  assert.equal(receipt.liveStoreScanned, false);
  assert.equal(recorded.length, 1);
  assert.deepEqual(deleted, []);
});
