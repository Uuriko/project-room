import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";

// auditWorkHelp made the same assumption auditCharters did: that the room's
// owner is whoever created it. Its compare() holds actual.room.ownerId against
// a projected one taken from room.created alone, so the first
// ownership.transferred in a room that uses help failed it permanently - and
// that fails auditRecovery, which gates backupRoom for every room.
//
// A transfer is also more than a new ownerId. src/events.js transferOwnership
// gives the new owner the full permission set and bumps their revision, and
// strips manage_members and decide from an outgoing AGENT owner. auditWorkHelp
// compares permissions and revision for every participant, so replaying half
// of a transfer does not help: the first version of this fix moved ownerId
// only, and the audit still failed.
//
// auditWorkHelp short-circuits to almost nothing until a help event exists, so
// every test here opens help first. That is exactly why this went unnoticed.

const W = "test-handoff";

function roomWithHelp(t) {
  const fixture = createAcceptanceFixture();
  t.after(() => { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
  const state = () => fixture.store.room("commons").state;
  const item = () => state().workItems[W];
  const send = (actor, type, data) => fixture.store.command(fixture.keys[actor], "commons", { id: randomUUID(), type, data: typeof data === "function" ? data() : data });

  send("producer", T.WORK_ACCEPTED, () => ({ workItemId: W, expectedRevision: item().revision }));
  send("producer", T.WORK_HELP_UPDATED, () => ({
    workItemId: W, expectedRevision: item().revision, expectedHelpRevision: item().helpWanted?.revision ?? 0,
    status: "open", scope: "A second pair of eyes", expiresAt: new Date(Date.now() + 3600_000).toISOString()
  }));
  return { ...fixture, state, item, send };
}

test("help is really open, so the audit is not passing vacuously", t => {
  const fixture = roomWithHelp(t);
  assert.equal(fixture.item().helpWanted.status, "open");
  assert.doesNotThrow(() => auditRecovery(fixture.store));
});

test("transferring a room that has open help keeps it auditable", t => {
  const fixture = roomWithHelp(t);
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "producer", reason: "handing over" });
  assert.deepEqual(fixture.store.room("commons"), fixture.store.rebuildProjection("commons"), "the projection was never wrong");
  assert.doesNotThrow(() => auditRecovery(fixture.store));
});

test("the permission changes a transfer makes are replayed, not just the owner id", t => {
  const fixture = roomWithHelp(t);
  const before = fixture.state().members.producer.revision;
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "producer", reason: "handing over" });

  const producer = fixture.state().members.producer;
  assert.deepEqual([...producer.permissions].sort(), [...PERMISSIONS].sort(), "the new owner holds everything");
  assert.equal(producer.revision, before + 1, "and their revision moved");
  // If the audit only tracked ownerId it would miss both of those and fail here.
  assert.doesNotThrow(() => auditRecovery(fixture.store));
});

test("the room stays auditable after it is archived post-transfer", t => {
  const fixture = roomWithHelp(t);
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "producer", reason: "handing over" });
  fixture.send("producer", T.ROOM_ARCHIVED, { reason: "pilot over" });
  assert.doesNotThrow(() => auditRecovery(fixture.store), "a stale ownerId poisons everything after it too");
});

test("a transfer to a non-member is still caught", t => {
  const fixture = roomWithHelp(t);
  fixture.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "producer", reason: "handing over" });
  const rows = fixture.store.db.prepare("SELECT rowid, body FROM events WHERE room_id=? AND body LIKE '%ownership.transferred%'").all("commons");
  assert.equal(rows.length, 1);
  const event = JSON.parse(rows[0].body);
  event.data.toMemberId = "never-a-member";
  fixture.store.db.prepare("UPDATE events SET body=? WHERE rowid=?").run(JSON.stringify(event), rows[0].rowid);
  assert.throws(() => auditRecovery(fixture.store));
});
