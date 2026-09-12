import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRecoveryFixture } from "../scripts/recovery-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-recovery-"));
  const f = createRecoveryFixture(join(directory, "source.sqlite"));
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...f, directory };
}

test("online capture preserves all 30 tables, identity boundaries and exact retries through recovery and restart", async t => {
  const f = fixture(t);
  const { identityId } = f.store.identities.create("Recovery agent");
  f.store.identities.link(f.keys.owner, "commons", { identityId, permissions: ["steer"] });
  f.store.invites.create(f.keys.owner, "commons", { permissions: ["steer"] });
  f.cursor = f.store.room("commons").sequence;
  f.store.markCaughtUp(f.keys.owner, "commons", f.cursor);
  const before = auditRecovery(f.store);
  assert.equal(before.rooms, 2); assert.equal(before.tables.length, 30);
  for (const table of before.tables) assert.ok(table.rows > 0, `${table.table} has substantive fixture data`);
  assert.equal(before.legacyCheckpoints, 1); assert.equal(before.replay.checkpointEvents, 2);
  const receipt = await backupRoom(f.filename, f.directory);
  assert.deepEqual(receipt.recovery, before);
  assert.equal(statSync(receipt.filename).mode & 0o777, 0o600);
  assert.equal(statSync(join(receipt.filename, "..")).mode & 0o777, 0o700);
  for (const privateValue of [f.keys.owner, f.pending.token, f.command.data.body, "recovery-target"]) assert.equal(JSON.stringify(before).includes(privateValue), false);
  const bytes = readFileSync(receipt.filename);
  const readonly = new RoomStore(receipt.filename, { readOnly: true, now: f.now });
  try { assert.deepEqual(auditRecovery(readonly), before); } finally { readonly.close(); }
  assert.deepEqual(readFileSync(receipt.filename), bytes, "verification is not repair or migration");

  // A captured copy intentionally lacks later revocations and writes. Do not
  // reopen it to users without reconciling authority and external effects.
  f.store.revoke(f.validSession.token);
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Synthetic post-capture write" } });
  assert.throws(() => f.store.authenticate(f.validSession.token), { code: "unauthenticated" });
  let recovered = new RoomStore(receipt.filename, { now: f.now });
  try {
    assert.deepEqual(auditRecovery(recovered), before);
    assert.equal(recovered.authenticate(f.validSession.token).member.id, "owner");
    for (const token of [f.revokedSession.token, f.keys.oldAgent, f.keys.commonsShared, f.keys.secondShared, f.loggedOut.token, f.sharedSession.token]) assert.throws(() => recovered.authenticate(token));
    assert.equal(recovered.authenticate(f.keys.agent).member.kind, "agent");
    assert.equal(recovered.authenticateAccountSession(f.owner.token, "commons", f.owner.session.sessionBinding).account.id, f.owner.session.account.id);
    assert.throws(() => recovered.snapshot(f.target.token, "commons", f.target.session.sessionBinding), /no membership/);
    assert.equal(recovered.previewInvitation(f.pending.token).status, "pending");
    assert.equal(recovered.issueInvitation(f.owner.token, "commons", f.pending).duplicate, true);
    assert.equal(recovered.command(f.keys.owner, "commons", f.command).duplicate, true);
    assert.equal(recovered.room("commons").sequence, f.cursor);
    for (const reminder of f.reminders.filter(row => ![f.keys.commonsShared, f.keys.secondShared].includes(row.token))) {
      const retry = recovered.reminders.mutate(reminder.token, reminder.room, reminder.request);
      assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, reminder.receipt);
    }
    assert.equal(recovered.reminders.list(f.keys.owner, "commons").reminders.length, 3);
    assert.equal(recovered.reminders.list(f.guestSlot.token, "commons").reminders.length, 1);
    const slot = recovered.accountSessionSlot(f.guestSlot.token);
    const retryJoin = recovered.shareLinks.join(f.guestSlot.token, f.linkToken, { ...f.joinRequest,
      expectedSessionRevision: slot.sessionRevision, expectedSessionBinding: slot.sessionBinding });
    assert.equal(retryJoin.duplicate, true); assert.equal(retryJoin.session.member.id, f.guest.session.member.id);
    assert.equal(recovered.shareLinks.list(f.keys.owner, "commons", null).links[0].joins, 1);
    assert.throws(() => recovered.shareLinks.preview(f.linkToken), { code: "link_unavailable" });
    const accepted = recovered.acceptInvitation(f.target.token, f.pending.token, { redemptionId: randomUUID(), expectedRevision: 0,
      expectedSessionBinding: f.target.session.sessionBinding });
    assert.equal(accepted.duplicate, false); assert.equal(accepted.session.member.id, "pending-human");
    const next = { id: "recovered-new-command", type: T.MESSAGE_POSTED, data: { body: "Synthetic new work after recovery" } };
    recovered.command(f.keys.owner, "commons", next);
    assert.equal(recovered.snapshot(f.keys.owner, "commons").cursor, f.cursor, "recovery never acknowledges new history");
    const after = auditRecovery(recovered);
    recovered.close(); recovered = new RoomStore(receipt.filename, { now: f.now });
    assert.deepEqual(auditRecovery(recovered), after);
    assert.equal(recovered.command(f.keys.owner, "commons", next).duplicate, true);
    const server = createRoomServer({ store: recovered, origin: "https://room.example.test" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await new Promise((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/rooms/commons",
          headers: { host: "room.example.test", authorization: `Bearer ${f.keys.owner}` } }, res => {
          let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
        }); req.on("error", reject); req.end();
      });
      assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).viewerId, "owner");
    } finally { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } finally { recovered.close(); }
  assert.equal(f.store.room("commons").sequence, f.cursor + 1, "recovery writes never replace the source");
});

test("audit permits overdue, cancelled, resolved, rescheduled and backward-clock reminder histories", t => {
  const f = fixture(t), store = f.store;
  f.advance(120000); assert.doesNotThrow(() => auditRecovery(store));
  f.advance(-180000);
  const old = f.reminders.find(row => row.token === f.keys.owner && row.request.workItemId === "active");
  store.reminders.mutate(f.keys.owner, "commons", { ...old.request, requestId: "backward-clock", expectedRevision: 1, dueAt: f.now() + 3600000 });
  // A member removal resolves an active reminder; reactivation permits a fresh
  // schedule, leaving a legitimate one-revision gap in the receipt ledger.
  const member = () => store.room("commons").state.members.agent;
  for (const active of [false, true]) store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "agent", expectedMemberRevision: member().revision, active, permissions: [] } });
  const agent = store.issueAccessKey("commons", "agent");
  store.reminders.mutate(agent, "commons", { requestId: "reactivated", workItemId: "active", expectedRevision: 2, action: "schedule", dueAt: f.now() + 60000 });
  assert.doesNotThrow(() => auditRecovery(store));
});

for (const fault of ["projection", "legacy-envelope", "missing-receipt", "receipt-fingerprint", "human-binding", "extra-table"])
  test(`read-only audit rejects ${fault} without repairing the source`, t => {
    const f = fixture(t), store = f.store, db = store.db;
    // Deliberate operator-level damage in this isolated fixture only.
    store.transaction(() => {
      if (fault === "projection") {
        const state = store.room("second").state; state.room.title = "Unrecorded edit";
        db.prepare("UPDATE rooms SET projection=? WHERE id='second'").run(JSON.stringify(state));
      } else if (fault === "legacy-envelope") {
        const row = db.prepare("SELECT id,body FROM events WHERE room_id='commons' AND sequence=1").get();
        const body = JSON.parse(row.body); body.at = "not a date";
        db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(body), row.id);
      } else if (fault === "missing-receipt" || fault === "receipt-fingerprint") {
        const trigger = `private_reminder_commands_no_${fault === "missing-receipt" ? "delete" : "update"}`;
        const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(trigger).sql; db.exec(`DROP TRIGGER ${trigger}`);
        if (fault === "missing-receipt") db.prepare("DELETE FROM private_reminder_commands WHERE room_id='commons' AND member_id='owner' AND request_id='schedule-cancelled'").run();
        else db.prepare("UPDATE private_reminder_commands SET fingerprint=? WHERE room_id='commons' AND member_id='owner' AND request_id='schedule-cancelled'").run(createHash("sha256").update("incorrect").digest("hex"));
        db.exec(sql);
      } else if (fault === "human-binding") db.prepare("DELETE FROM member_accounts WHERE room_id='commons' AND member_id='owner'").run();
      else db.exec("CREATE TABLE unexpected_table(value TEXT)");
    });
    const before = db.prepare("SELECT total_changes() n").get().n;
    assert.throws(() => auditRecovery(store));
    assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
  });

test("v8 readonly verification refuses a v7 marker rather than migrating the backup", t => {
  const f = fixture(t); f.store.db.exec("PRAGMA user_version=7");
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /schema|version|migration/i);
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 7);
});
