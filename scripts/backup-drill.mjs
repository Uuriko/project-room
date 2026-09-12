// Backup/restore drill: prove a live room survives a sqlite backup round-trip.
// Usage: node scripts/backup-drill.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { backupRoom } from "../server/backup.mjs";

const directory = mkdtempSync(join(tmpdir(), "room-backup-drill-"));
const filename = join(directory, "room.sqlite");
const store = new RoomStore(filename);
store.initialize(initialRoom());
const ownerKey = store.issueAccessKey("commons", "owner");
// Representative data: member, messages, work item with a claim.
store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
  data: { memberId: "drill-agent", displayName: "Drill Agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
for (let i = 0; i < 5; i++) store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
  data: { messageId: randomUUID(), body: `drill message ${i}` } });
store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
  workItemId: "drill-task", title: "Drill task", definitionOfDone: "Survives backup", accountableMemberId: "drill-agent", mode: "read" } });
const before = {
  events: store.db.prepare("SELECT count(*) AS n FROM events").get().n,
  members: Object.keys(store.room("commons").state.members).length,
  workItems: Object.keys(store.room("commons").state.workItems).length,
};
store.close();

const backupDir = mkdtempSync(join(tmpdir(), "room-backup-dest-"));
const result = await backupRoom(filename, backupDir);
assert.equal(result.verified, true, "backup must verify on restore");
assert.ok(result.filename.endsWith("room.sqlite"), "backup must produce a sqlite file");

// Open the backup independently and compare the data.
const restored = new RoomStore(result.filename, { readOnly: true });
const after = {
  events: restored.db.prepare("SELECT count(*) AS n FROM events").get().n,
  members: Object.keys(restored.room("commons").state.members).length,
  workItems: Object.keys(restored.room("commons").state.workItems).length,
};
assert.deepEqual(after, before, "restored room must match the live room");
const drillMsg = restored.db.prepare("SELECT body FROM events WHERE body LIKE '%drill message 3%'").get();
assert.ok(drillMsg, "message content must survive the round-trip");
restored.close();
console.log(JSON.stringify({ ok: true, before, after, audit: result.recovery ? "recovery-audit-passed" : "no-recovery-audit" }));
rmSync(directory, { recursive: true, force: true });
rmSync(backupDir, { recursive: true, force: true });
