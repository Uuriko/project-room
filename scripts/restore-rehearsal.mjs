// Restore rehearsal (backlog B5): prove that restoring a stale backup
// resurrects the authority that was live at the watermark, and that
// reconcileRestoredAuthority names every resurrected entry - so stale
// restored authority is never silently treated as current.
// Usage: node scripts/restore-rehearsal.mjs
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { backupRoom, reconcileRestoredAuthority } from "../server/backup.mjs";

const directory = mkdtempSync(join(tmpdir(), "room-restore-rehearsal-"));
const backupDest = mkdtempSync(join(tmpdir(), "room-backup-dest-"));
try {
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });

  // Authority live at backup time: guest human with a key, an open share link,
  // a connected agent, plus history.
  send(T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest", kind: "human", permissions: [] });
  const guestKey = store.issueAccessKey("commons", "guest");
  const link = store.shareLinks.create(owner, "commons", { requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000, maxJoins: 10, expectedMemberRevision: 0 }, null).link;
  const session = store.createSession(owner);
  store.agentConnections.apply(session.token, "commons", { action: "create", requestId: randomUUID(), memberId: "agent-a", displayName: "Agent",
    access: "contribute", keyHash: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"),
    expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  send(T.MESSAGE_POSTED, { messageId: randomUUID(), body: "history before the backup" });

  const backupResult = await backupRoom(filename, backupDest);
  const watermark = JSON.parse(readFileSync(backupResult.watermark, "utf8"));
  assert.equal(watermark.version, 1);
  assert.equal(watermark.events, store.db.prepare("SELECT count(*) AS n FROM events").get().n, "watermark pins the event count");
  assert.ok(watermark.backedUpAt <= Date.now());

  // The live timeline moves on: every one of those grants is withdrawn.
  store.revoke(guestKey);
  const guest = store.room("commons").state.members.guest;
  send(T.MEMBER_ACCESS_CHANGED, { memberId: "guest", expectedMemberRevision: guest.revision, permissions: [], active: false });
  store.shareLinks.cancel(owner, "commons", link.id, null);
  const agentMember = store.room("commons").state.members["agent-a"];
  store.agentConnections.apply(session.token, "commons", { action: "disconnect", requestId: randomUUID(), memberId: "agent-a",
    expectedOwnerRevision: store.room("commons").state.members.owner.revision, expectedGeneration: 1,
    expectedMemberRevision: agentMember.revision }, session.session.sessionBinding);

  // Restore the stale backup. Without reconciliation every withdrawn grant
  // looks current again - prove that, then prove the reconcile catches it.
  const restored = new RoomStore(backupResult.filename, { readOnly: true });
  try {
    const eventsAfter = restored.db.prepare("SELECT count(*) AS n FROM events").get().n;
    assert.equal(eventsAfter, watermark.events, "restored history matches the watermark");
    assert.ok(restored.db.prepare("SELECT body FROM events WHERE body LIKE '%history before the backup%'").get(), "restored history is readable");

    const resurrected = {
      credential: restored.db.prepare("SELECT revoked FROM credentials WHERE revoked=0 AND kind='access'").all().length >= 2,
      link: restored.db.prepare("SELECT revoked_at FROM share_links WHERE id=?").get(link.id).revoked_at === null,
      member: restored.room("commons").state.members.guest.active === true,
      connection: restored.db.prepare("SELECT status FROM agent_connections WHERE member_id='agent-a'").get().status === "issued"
    };
    assert.deepEqual(resurrected, { credential: true, link: true, member: true, connection: true },
      "restore silently resurrects withdrawn authority - this is the hazard B5 guards");

    const report = reconcileRestoredAuthority(restored, store);
    const byKind = Object.groupBy(report.stale, row => row.kind);
    assert.equal(byKind.credential?.length, 2, "guest key and agent connection key both named");
    assert.ok(byKind.credential.some(row => /for guest@/.test(row.detail)), "revoked guest key named");
    assert.ok(byKind.credential.some(row => /for agent-a@/.test(row.detail)), "disconnected agent key named");
    for (const row of byKind.credential) assert.match(row.detail, /revoked after the backup/);
    assert.equal(byKind.share_link?.length, 1, "cancelled share link named");
    assert.match(byKind.share_link[0].detail, /cancelled after the backup/);
    assert.equal(byKind.member?.length, 2, "deactivated guest and agent members both named");
    assert.ok(byKind.member.some(row => row.id.includes("guest")), "guest member named");
    assert.ok(byKind.member.some(row => row.id.includes("agent-a")), "agent member named");
    for (const row of byKind.member) assert.match(row.detail, /deactivated after the backup/);
    assert.equal(byKind.agent_connection?.length, 1, "disconnected agent connection named");
    assert.match(byKind.agent_connection[0].detail, /disconnected after the backup/);
    assert.equal(report.stale.length, 6, "no other stale authority in a clean rehearsal");
    assert.equal(report.checked.credentials, restored.db.prepare("SELECT count(*) AS n FROM credentials").get().n);
    assert.deepEqual({ ...report.checked, credentials: 0 }, { credentials: 0, shareLinks: 1, agentConnections: 1, accounts: 2, rooms: 1 });

    // A restore reconciled against a reference that made no changes is clean.
    const quiet = await backupRoom(filename, backupDest);
    const quietRestored = new RoomStore(quiet.filename, { readOnly: true });
    try {
      assert.deepEqual(reconcileRestoredAuthority(quietRestored, store).stale, [], "post-mutation backup reconciles clean");
    } finally { quietRestored.close(); }

    console.log("restore rehearsal OK:");
    for (const row of report.stale) console.log(`  stale ${row.kind}: ${row.id} - ${row.detail}`);
    console.log(`  checked: ${JSON.stringify(report.checked)}`);
  } finally { restored.close(); }
  store.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
  rmSync(backupDest, { recursive: true, force: true });
}
