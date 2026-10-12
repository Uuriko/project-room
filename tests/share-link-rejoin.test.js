// r104: a member who leaves a room comes back with a fresh valid invitation;
// a member the owner removed does not.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function setup(t) {
  const directory = mkdtempSync(pathJoin(tmpdir(), "room-rejoin-"));
  const store = new RoomStore(pathJoin(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const slot = store.createAccountSessionSlot();
  const link = (extra = {}) => {
    const linkToken = randomBytes(32).toString("base64url");
    store.shareLinks.create(ownerKey, "commons", { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 5,
      expectedMemberRevision: store.room("commons").state.members.owner.revision, ...extra }, null);
    return linkToken;
  };
  const join = linkToken => {
    const s = store.accountSessionSlot(slot.token);
    return store.shareLinks.join(slot.token, linkToken, { displayName: "Friend", redemptionId: randomUUID(), expectedSessionRevision: s.sessionRevision, expectedSessionBinding: s.sessionBinding });
  };
  const members = () => store.room("commons").state.members;
  const setActive = (actorKey, memberId, active) => {
    const m = members()[memberId];
    store.command(actorKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: { memberId, expectedMemberRevision: m.revision, permissions: [...m.permissions], active } });
  };
  const bindings = () => store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='commons'").get().n;
  return { store, ownerKey, link, join, members, setActive, bindings };
}

test("a member who left comes back with a fresh invitation: reactivated once, no second binding", t => {
  const { store, ownerKey, link, join, members, setActive, bindings } = setup(t);
  const first = join(link()), id = first.session.member.id, before = bindings();
  // The member leaves with their own session credential, like the Leave room button.
  const memberKey = store.issueAccessKey("commons", id);
  setActive(memberKey, id, false);
  assert.equal(members()[id].active, false);
  const back = join(link());
  assert.equal(back.session.member.id, id);
  assert.equal(members()[id].active, true);
  assert.equal(bindings(), before, "no duplicate member_accounts row");
  assert.equal(Object.values(members()).filter(m => m.displayName === "Friend").length, 1, "no second roster entry");
  // Joining again while active is the ordinary duplicate path.
  assert.equal(join(link()).duplicate, true);
  assert.ok(ownerKey);
});

test("the permissions of the new invitation apply, not the old membership's", t => {
  const { store, link, join, members, setActive } = setup(t);
  const id = join(link()).session.member.id, guestPermissions = [...members()[id].permissions];
  setActive(store.issueAccessKey("commons", id), id, false);
  const back = join(link({ access: "member" }));
  assert.equal(back.session.member.id, id);
  assert.equal(members()[id].active, true);
  assert.notDeepEqual([...members()[id].permissions].sort(), guestPermissions.sort());
});

test("a member the owner removed stays blocked, with a clear error, and is not reactivated", t => {
  const { ownerKey, link, join, members, setActive, bindings } = setup(t);
  const id = join(link()).session.member.id, before = bindings();
  setActive(ownerKey, id, false);
  assert.throws(() => join(link()), error => error.status === 403 && error.code === "membership_removed");
  assert.equal(members()[id].active, false);
  assert.equal(bindings(), before);
});

test("a self-left member cannot use a cancelled or expired link", t => {
  const { store, ownerKey, link, join, members, setActive } = setup(t);
  const id = join(link()).session.member.id;
  setActive(store.issueAccessKey("commons", id), id, false);
  const token = link(), row = store.shareLinks.find(token);
  store.shareLinks.cancel(ownerKey, "commons", row.id, null);
  assert.throws(() => join(token), error => error.status === 410);
  assert.equal(members()[id].active, false);
});
