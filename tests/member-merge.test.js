// Owner merge moves history, claims, and permissions onto the kept agent.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-merge-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (memberId, displayName, permissions) => {
    store.command(ownerKey, "commons", {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName, kind: "agent", permissions }
    });
    return store.mintAccessKey("commons", memberId);
  };
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ store, ownerKey, add, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

test("merge keeps one agent and an invite-only member cannot merge", async t => {
  const { store, ownerKey, add, origin } = await boot(t);
  const keptKey = add("ada", "Ada Agent", ["steer", "accept_work"]);
  const retiredKey = add("ada2", "Ada Two", ["verify"]);
  add("inviter", "Invite Agent", ["invite_member"]);
  store.command(retiredKey, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "note-1", body: "Draft from the duplicate" }
  });
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.WORK_PROPOSED,
    data: { workItemId: "job-1", title: "Draft", definitionOfDone: "Posted", accountableMemberId: "ada2", mode: "read" }
  });
  const keptIdentity = store.identities.create("Ada Agent");
  const retiredIdentity = store.identities.create("Ada Two");
  const now = store.now();
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)").run("commons", keptIdentity.identityId, "ada", now);
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)").run("commons", retiredIdentity.identityId, "ada2", now);
  store.db.prepare("INSERT INTO work_claims(room_id, claim_id, item_json, updated_at) VALUES(?,?,?,?)")
    .run("commons", "claim-1", JSON.stringify({ holderId: "ada2", title: "Draft" }), now);
  const inviterKey = store.mintAccessKey("commons", "inviter");
  const refused = await fetch(origin + "/api/rooms/commons/members/merge", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${inviterKey}` },
    body: JSON.stringify({ keepMemberId: "ada", retireMemberId: "ada2" })
  });
  assert.equal(refused.status, 403);
  const merged = await fetch(origin + "/api/rooms/commons/members/merge", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ keepMemberId: "ada", retireMemberId: "ada2" })
  });
  const body = await merged.json();
  assert.equal(merged.status, 200, JSON.stringify(body));
  const state = store.room("commons").state;
  assert.equal(state.members.ada2.active, false);
  assert.equal(state.members.ada2.mergedInto, "ada");
  assert.deepEqual(state.members.ada.mergedFrom, ["ada2"]);
  assert.ok(state.members.ada.permissions.includes("steer"));
  assert.ok(state.members.ada.permissions.includes("verify"));
  assert.equal(state.messages.find(message => message.id === "note-1").authorId, "ada");
  assert.equal(state.workItems["job-1"].accountableMemberId, "ada");
  const claim = JSON.parse(store.db.prepare("SELECT item_json FROM work_claims WHERE claim_id=?").get("claim-1").item_json);
  assert.equal(claim.holderId, "ada");
  assert.equal(store.db.prepare("SELECT member_id FROM identity_links WHERE identity_id=?").get(retiredIdentity.identityId).member_id, "ada");
  const log = store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons").map(row => JSON.parse(row.body));
  assert.ok(log.some(event => event.type === "member.merged" && event.data.retiredMemberId === "ada2"));
  assert.equal(store.authenticate(keptKey, "commons").member.id, "ada");
});

test("a co-owner with manage_members and decide can merge but cannot grant admin bits", async t => {
  const { store, ownerKey, add } = await boot(t);
  const coKey = add("co", "Co Agent", ["manage_members", "decide", "steer"]);
  add("kept", "Kept Agent", ["steer"]);
  add("extra", "Extra Agent", ["manage_members", "decide", "verify"]);
  const result = store.pairing.merge(coKey, "commons", { keepMemberId: "kept", retireMemberId: "extra" });
  assert.equal(result.retired, true);
  const kept = store.room("commons").state.members.kept;
  assert.ok(kept.permissions.includes("verify"));
  assert.ok(!kept.permissions.includes("manage_members"));
  assert.ok(!kept.permissions.includes("decide"));
  const ownerMerge = store.pairing.merge(ownerKey, "commons", { keepMemberId: "kept", retireMemberId: "co" });
  assert.equal(ownerMerge.keepMemberId, "kept");
  assert.ok(store.room("commons").state.members.kept.permissions.includes("manage_members"));
});
