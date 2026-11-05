// Pool E (one-bad-row denial): a single agent_invite_codes row whose stored
// permissions_json no longer parses (legacy writer, partial write, or
// corruption) must not deny the whole collection read. The owner invite
// list and the access review must serve every well-formed invite and mark
// the bad row visibly as unreadable, never silently drop it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { assembleAccessReview } from "../server/access-review.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invites-one-bad-row-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const good = store.invites.create(ownerKey, "commons", { permissions: ["accept_work", "complete_work"], expiresInMinutes: 60, displayName: "Good Bot" }, null);
  const bad = store.invites.create(ownerKey, "commons", { permissions: ["steer"], expiresInMinutes: 60, displayName: "Legacy Bot" }, null);
  return { store, ownerKey, good, bad };
}

const corrupt = (store, inviteId, value) => {
  // inviteId is the first 8 hex chars of the stored code hash (inviteId() in
  // server/agent-invites.mjs), so the row is reachable without decoding it.
  const changed = store.db.prepare("UPDATE agent_invite_codes SET permissions_json=? WHERE substr(code_hash,1,8)=?")
    .run(value, inviteId).changes;
  assert.equal(changed, 1, "exactly one stored invite row is corrupted");
};

test("one corrupt invite row does not deny the owner invite list", t => {
  const { store, ownerKey, good, bad } = fixture(t);
  corrupt(store, bad.inviteId, "{corrupt");
  const listed = store.invites.list(ownerKey, "commons", null);
  assert.equal(listed.length, 2, "both invites are served, the bad row is not dropped");
  const goodRow = listed.find(row => row.inviteId === good.inviteId);
  assert.ok(Array.isArray(goodRow.permissions) && goodRow.permissions.length > 0, "the good invite keeps its permissions");
  assert.equal(goodRow.unreadable, undefined);
  const badRow = listed.find(row => row.inviteId === bad.inviteId);
  assert.equal(badRow.permissions, null, "the bad row carries no invented permissions");
  assert.equal(badRow.unreadable, true, "the bad row is visibly marked unreadable");
  assert.equal(badRow.displayName, "Legacy Bot", "the bad row's plain columns still serve");
  assert.equal(badRow.status, "active");
});

test("one corrupt invite row does not deny the access review", t => {
  const { store, good, bad } = fixture(t);
  corrupt(store, bad.inviteId, "{corrupt");
  const report = assembleAccessReview(store, "commons");
  assert.equal(report.counts.pendingInvites, 2);
  const goodRow = report.pendingInvites.find(row => row.inviteId === good.inviteId);
  assert.ok(Array.isArray(goodRow.permissions) && goodRow.permissions.length > 0);
  assert.equal(goodRow.unreadable, undefined);
  const badRow = report.pendingInvites.find(row => row.inviteId === bad.inviteId);
  assert.equal(badRow.permissions, null);
  assert.equal(badRow.unreadable, true, "the review marks the bad invite instead of failing whole");
  assert.ok(report.members.length > 0, "the rest of the review still serves");
});

test("a wrong-shape stored permissions value is isolated the same way", t => {
  const { store, ownerKey, good, bad } = fixture(t);
  corrupt(store, bad.inviteId, JSON.stringify({ permissions: "steer" }));
  const listed = store.invites.list(ownerKey, "commons", null);
  const badRow = listed.find(row => row.inviteId === bad.inviteId);
  assert.equal(badRow.permissions, null);
  assert.equal(badRow.unreadable, true);
  const goodRow = listed.find(row => row.inviteId === good.inviteId);
  assert.ok(Array.isArray(goodRow.permissions));
});
