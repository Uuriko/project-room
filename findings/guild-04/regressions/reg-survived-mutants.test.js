// wave1000 guild-04 fail-first regression tests for SURVIVED mutants.
// Each test passes on the original code and FAILS on the corresponding mutant
// from findings/guild-04/specs/*.json. Run: node --test <this file> with
// TMPDIR pointed at a worktree-local dir.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../../server/store.mjs";
import { initialRoom } from "../../../server/bootstrap.mjs";
import { RoomDirectory } from "../../../server/room-directory.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../../../server/work-claim-sqlite.mjs";

const WT = "/home/hatch/workspace/pr-wave1000-guild-04";
const freshDir = (t, prefix) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// --- S4 (spec-store): dropping COMMIT in RoomStore.transaction must be caught.
// The suite passed 22/22 with the transaction never committed.
test("S4: store.transaction commits — writes visible after close/reopen, no dangling txn", t => {
  const file = join(freshDir(t, "g04-s4-"), "s.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom("commons"));
  const dir = new RoomDirectory(store);
  dir.set("commons", "owner", true);
  dir.set("commons", "owner", false); // throws "cannot start a transaction within a transaction" when COMMIT is dropped
  store.close();
  const db2 = new DatabaseSync(file);
  t.after(() => db2.close());
  const row = db2.prepare("SELECT discoverable FROM room_directory_settings WHERE room_id='commons'").get();
  assert.ok(row, "transactional write lost — COMMIT never happened");
  assert.equal(row.discoverable, 0, "second transaction's write not committed");
});

// --- W4 (spec-work-claim-sqlite): list() must return insertion order.
test("W4: claim list() returns insertion (rowid ASC) order", t => {
  const file = join(freshDir(t, "g04-w4-"), "c.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(workClaimSchema);
  const reg = createDurableWorkClaimRegistry(db);
  for (const id of ["c", "a", "b"]) reg.set("room1", { id, title: id });
  assert.deepEqual(reg.list("room1").map(i => i.id), ["c", "a", "b"]);
});

// --- W5 (spec-work-claim-sqlite): new claims default to "unclaimed".
test("W5: decoded claim defaults to state=unclaimed", t => {
  const file = join(freshDir(t, "g04-w5-"), "c.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(workClaimSchema);
  const reg = createDurableWorkClaimRegistry(db);
  reg.set("room1", { id: "x" });
  assert.equal(reg.get("room1", "x").state, "unclaimed");
});

// --- W1 (spec-work-claim-sqlite): delete() waives the deleted id from dependents.
test("W1: delete() removes the deleted claim from dependents' dependsOn", t => {
  const file = join(freshDir(t, "g04-w1-"), "c.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(workClaimSchema);
  const reg = createDurableWorkClaimRegistry(db);
  reg.set("room1", { id: "dep", title: "dep" });
  reg.set("room1", { id: "main", title: "main", dependsOn: ["dep", "other"] });
  reg.delete("room1", "dep");
  assert.deepEqual(reg.get("room1", "main").dependsOn, ["other"]);
  assert.equal(reg.get("room1", "dep"), null);
});

// --- W2 (spec-work-claim-sqlite): decode falls back title to id.
test("W2: decoded claim title falls back to id when absent", t => {
  const file = join(freshDir(t, "g04-w2-"), "c.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(workClaimSchema);
  const reg = createDurableWorkClaimRegistry(db);
  reg.set("room1", { id: "notitle" });
  assert.equal(reg.get("room1", "notitle").title, "notitle");
});

// --- D1 (spec-room-directory): nextCursor is null on an exact page boundary.
test("D1: directory list() emits no nextCursor when the page exactly fills", t => {
  const file = join(freshDir(t, "g04-d1-"), "s.sqlite");
  const store = new RoomStore(file);
  t.after(() => store.close());
  for (const r of ["gda", "gdb", "gdc"]) store.initialize(initialRoom(r));
  const dir = new RoomDirectory(store);
  for (const r of ["gda", "gdb", "gdc"]) dir.set(r, "owner", true);
  const page = dir.list({ limit: 3 });
  assert.equal(page.rooms.length, 3);
  assert.equal(page.nextCursor, null, "phantom nextCursor on exact page boundary");
});

// --- D5 (spec-room-directory): public_receipts defaults to public (1).
test("D5: directory settings default public_receipts=1 (public)", t => {
  const file = join(freshDir(t, "g04-d5-"), "s.sqlite");
  const store = new RoomStore(file);
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const dir = new RoomDirectory(store);
  dir.set("commons", "owner", true);
  assert.equal(dir.status("commons", "owner").publicReceipts, true);
});

// --- P3 (spec-room-activation-pack): pins are filtered by viewer visibility.
// A DM pinned in the room must not leak to a third-party viewer.
test("P3: activation pack pins are filtered by messageVisibleToViewer", async t => {
  const { buildActivationPack } = await import("../../../server/room-activation-pack.mjs");
  const { EVENT_TYPES: T, PERMISSIONS, event } = await import("../../../src/events.js");
  const file = join(freshDir(t, "g04-p3-"), "s.sqlite");
  const store = new RoomStore(file);
  t.after(() => store.close());
  const ROOM = "pinvis";
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "Pin Vis", purpose: "p", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "worker", displayName: "Worker", kind: "agent", permissions: ["accept_work"] } }),
  ]);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  // DM from owner to worker, then pinned.
  store.command(ownerKey, ROOM, { id: "dm1", type: T.MESSAGE_POSTED, data: {
    messageId: "dm-secret", body: "secret dm", toMemberId: "worker" } });
  store.command(ownerKey, ROOM, { id: "pin1", type: T.MESSAGE_PINNED, data: { messageId: "dm-secret" } });
  const forWorker = buildActivationPack(store, ROOM, "worker");
  assert.ok(forWorker.pinnedResources.some(p => p.messageId === "dm-secret"),
    "addressee lost their own pinned DM");
  const forIntruder = buildActivationPack(store, ROOM, "intruder");
  assert.ok(!forIntruder.pinnedResources.some(p => p.messageId === "dm-secret"),
    "pinned DM leaked to an unauthorized viewer");
});

// H3: a deleted message's tombstone must scrub the body text — retaining it
// keeps sensitive text in the exported message model (room-export-html.mjs).
test("H3: deleted message tombstone scrubs the body", async t => {
  const { walkExport } = await import("../../../server/room-export-html.mjs");
  const { EVENT_TYPES: T, event } = await import("../../../src/events.js");
  const rows = [
    { sequence: 1, event: event({ type: T.MESSAGE_POSTED, actorId: "a", roomId: "r",
      data: { messageId: "m1", body: "secret text" } }) },
    { sequence: 2, event: event({ type: T.MESSAGE_DELETED, actorId: "a", roomId: "r",
      data: { messageId: "m1" } }) },
  ];
  const { messages } = walkExport(rows);
  const m = messages.get("m1");
  assert.ok(m.deleted, "message must be marked deleted");
  assert.equal(m.body, null, "tombstoned message must not retain body text");
});

// E2 (room-export.mjs cellOf canonical-base64 check): covered by
// tests/rel14-backup-bytes.test.js ("junk" case asserts /not canonical base64/);
// verified KILLED by that file 2026-10-09. No duplicate regression test needed.

console.log(`regression module loaded (WT=${WT})`);
