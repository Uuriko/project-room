// CD-06 (CONVO CV-3): claim follow records with totals.
//
// Membership-style follow rows per (member, claim): implicit follows on
// create / claim / comment / mention / review-assignment, a per-claim
// follow|mute|inherit override that never deletes history, unread + mention
// counters driven by claim events since last read, and the totals shape
// CD-01's needs-me surface consumes.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  claimFollowTotals, claimIdForWorkItem, followClaim, getClaimFollow,
  listClaimFollows, markClaimFollowRead, recordClaimFollowActivity,
  setClaimFollowPolicy, syncClaimFollowsForDiscussion, syncClaimFollowsForEvent
} from "../server/claim-follows.mjs";
import { workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const db = () => {
  const handle = new DatabaseSync(":memory:");
  handle.exec(workClaimSchema);
  return handle;
};
const at = 1_760_000_000_000;
const scope = { roomId: "room1", claimId: "c1" };

test("followClaim creates a follow row; re-following keeps the first via and policy", () => {
  const handle = db();
  const created = followClaim(handle, { ...scope, memberId: "alice", via: "create", at, seq: 3 });
  assert.equal(created.policy, "follow");
  assert.equal(created.following, true);
  assert.equal(created.createdVia, "create");
  assert.equal(created.lastReadSeq, 3);
  assert.equal(created.lastEventSeq, 3);
  assert.equal(created.unreadCount, 0);
  assert.equal(created.updatedAt, new Date(at).toISOString());
  const again = followClaim(handle, { ...scope, memberId: "alice", via: "comment", at: at + 1, seq: 9 });
  assert.equal(again.createdVia, "create", "first involvement stays the provenance");
  assert.equal(again.lastReadSeq, 3, "a repeat follow never rewinds the read marker");
});

test("auto-follow triggers: create, claim, comment (review), review-assignment, mention attention", () => {
  const handle = db();
  syncClaimFollowsForEvent(handle, { ...scope, action: "created", actorId: "alice", sequence: 1, item: { id: "c1", owner: null }, at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "alice" }).createdVia, "create");

  syncClaimFollowsForEvent(handle, { ...scope, action: "claimed", actorId: "bob", sequence: 2, item: { id: "c1", owner: "bob" }, at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "bob" }).createdVia, "claim");

  syncClaimFollowsForEvent(handle, { ...scope, action: "reviewed", actorId: "carol", sequence: 3, item: { id: "c1", owner: "bob" }, at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "carol" }).createdVia, "comment");

  syncClaimFollowsForEvent(handle, { ...scope, action: "state_changed", actorId: "bob", sequence: 4,
    item: { id: "c1", owner: "bob" }, reviewerIds: ["dana"], at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "dana" }).createdVia, "review-assignment");

  syncClaimFollowsForEvent(handle, { ...scope, action: "state_changed", actorId: "bob", sequence: 5,
    item: { id: "c1", owner: "bob" }, attentionMemberId: "erin", at });
  const erin = getClaimFollow(handle, { ...scope, memberId: "erin" });
  assert.equal(erin.createdVia, "mention");
  assert.equal(erin.mentionCount, 1, "the attention event itself counts as her mention");
  assert.equal(erin.unreadCount, 1);
});

test("counters: claim events accrue unread for other followers, never the actor; read resets", () => {
  const handle = db();
  followClaim(handle, { ...scope, memberId: "alice", via: "create", at, seq: 1 });
  followClaim(handle, { ...scope, memberId: "bob", via: "claim", at, seq: 1 });

  recordClaimFollowActivity(handle, { ...scope, seq: 2, actorId: "alice", at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "alice" }).unreadCount, 0, "actor excluded");
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "bob" }).unreadCount, 1);
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "bob" }).lastEventSeq, 2);

  recordClaimFollowActivity(handle, { ...scope, seq: 3, actorId: "bob", mentionMemberIds: ["alice"], at });
  const alice = getClaimFollow(handle, { ...scope, memberId: "alice" });
  assert.equal(alice.unreadCount, 1);
  assert.equal(alice.mentionCount, 1, "mentions count separately from unread");

  const read = markClaimFollowRead(handle, { ...scope, memberId: "alice", at });
  assert.equal(read.unreadCount, 0);
  assert.equal(read.mentionCount, 0);
  assert.equal(read.lastReadSeq, 3, "read advances lastReadSeq to the latest event seq");
  assert.equal(markClaimFollowRead(handle, { ...scope, memberId: "nobody", at }), null, "reading never subscribes");
});

test("mute/re-follow override: policy flips, history and counters survive, mute stops accrual", () => {
  const handle = db();
  followClaim(handle, { ...scope, memberId: "alice", via: "create", at, seq: 1 });
  recordClaimFollowActivity(handle, { ...scope, seq: 2, actorId: "bob", at });

  const muted = setClaimFollowPolicy(handle, { ...scope, memberId: "alice", policy: "mute", at });
  assert.equal(muted.policy, "mute");
  assert.equal(muted.following, false);
  assert.equal(muted.unreadCount, 1, "muting never deletes the record's history");
  assert.equal(muted.createdVia, "create");

  recordClaimFollowActivity(handle, { ...scope, seq: 3, actorId: "bob", at });
  const still = getClaimFollow(handle, { ...scope, memberId: "alice" });
  assert.equal(still.unreadCount, 1, "muted rows accrue nothing");
  assert.equal(still.lastEventSeq, 3, "the event horizon still advances");

  // Later involvement must not silently un-mute her.
  syncClaimFollowsForEvent(handle, { ...scope, action: "state_changed", actorId: "bob", sequence: 4,
    item: { id: "c1", owner: "bob" }, reviewerIds: ["alice"], at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "alice" }).policy, "mute");

  const refollowed = setClaimFollowPolicy(handle, { ...scope, memberId: "alice", policy: "follow", at });
  assert.equal(refollowed.policy, "follow");
  assert.equal(setClaimFollowPolicy(handle, { ...scope, memberId: "alice", policy: "inherit", at }).policy, "inherit");
  assert.throws(() => setClaimFollowPolicy(handle, { ...scope, memberId: "alice", policy: "loud", at }), /unknown claim follow policy/);
});

test("totals shape: per-room and cross-room aggregates for CD-01", () => {
  const handle = db();
  followClaim(handle, { ...scope, memberId: "alice", via: "create", at, seq: 1 });
  followClaim(handle, { roomId: "room1", claimId: "c2", memberId: "alice", via: "claim", at, seq: 1 });
  followClaim(handle, { roomId: "room2", claimId: "c9", memberId: "alice", via: "mention", at, seq: 1 });
  setClaimFollowPolicy(handle, { roomId: "room2", claimId: "c9", memberId: "alice", policy: "mute", at });
  recordClaimFollowActivity(handle, { ...scope, seq: 2, actorId: "bob", mentionMemberIds: ["alice"], at });
  recordClaimFollowActivity(handle, { roomId: "room1", claimId: "c2", seq: 2, actorId: "bob", at });

  assert.deepEqual(claimFollowTotals(handle, { roomId: "room1", memberId: "alice" }),
    { followedClaims: 2, unreadClaims: 2, unreadEvents: 2, mentions: 1 });
  assert.deepEqual(claimFollowTotals(handle, { memberId: "alice" }),
    { followedClaims: 2, unreadClaims: 2, unreadEvents: 2, mentions: 1 },
    "cross-room totals count follow-policy rows; the muted room2 row adds nothing");
  assert.deepEqual(claimFollowTotals(handle, { memberId: "ghost" }),
    { followedClaims: 0, unreadClaims: 0, unreadEvents: 0, mentions: 0 });
  assert.equal(listClaimFollows(handle, { roomId: "room1", memberId: "alice" }).length, 2);
});

test("discussion sync: author follows via comment, @mentions follow via mention and accrue", () => {
  const handle = db();
  followClaim(handle, { ...scope, memberId: "alice", via: "create", at, seq: 1 });
  syncClaimFollowsForDiscussion(handle, { ...scope, authorId: "bob", mentionMemberIds: ["alice"], sequence: 7, at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "bob" }).createdVia, "comment");
  const alice = getClaimFollow(handle, { ...scope, memberId: "alice" });
  assert.equal(alice.unreadCount, 1);
  assert.equal(alice.mentionCount, 1);
  assert.equal(alice.lastEventSeq, 7);
  syncClaimFollowsForDiscussion(handle, { ...scope, authorId: "carol", mentionMemberIds: [], sequence: 8, at });
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "carol" }).createdVia, "comment");
  assert.equal(getClaimFollow(handle, { ...scope, memberId: "alice" }).unreadCount, 2);
});

test("claimIdForWorkItem resolves a direct claim id and a workItemId link", () => {
  const handle = db();
  handle.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?,?,?,?)")
    .run("room1", "c1", JSON.stringify({ id: "c1" }), at);
  handle.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?,?,?,?)")
    .run("room1", "c2", JSON.stringify({ id: "c2", workItemId: "wi-2" }), at);
  assert.equal(claimIdForWorkItem(handle, "room1", "c1"), "c1");
  assert.equal(claimIdForWorkItem(handle, "room1", "wi-2"), "c2");
  assert.equal(claimIdForWorkItem(handle, "room1", "nope"), null);
});

// --- HTTP door integration -------------------------------------------------

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, kind, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added", data: { memberId: id, displayName, kind, permissions }
  });
  add("alice", "Alice", "agent", ["accept_work", "complete_work"]);
  add("verifier", "Verifier", "human", ["verify"]);
  const aliceKey = store.issueAccessKey("commons", "alice");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { store, ownerKey, aliceKey, call };
}

test("door: lifecycle auto-follow, totals, mute, read — end to end", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "c1", title: "Followed work" })).status, 201);
  const creator = getClaimFollow(f.store.db, { roomId: "commons", memberId: "owner", claimId: "c1" });
  assert.equal(creator.createdVia, "create");

  assert.equal((await f.call(f.aliceKey, "/work-claims/c1/claim", {})).status, 200);
  assert.equal(getClaimFollow(f.store.db, { roomId: "commons", memberId: "alice", claimId: "c1" }).createdVia, "claim");
  assert.equal(getClaimFollow(f.store.db, { roomId: "commons", memberId: "owner", claimId: "c1" }).unreadCount, 1,
    "the claim event accrues unread for the creator");

  assert.equal((await f.call(f.aliceKey, "/work-claims/c1/update", { note: "started" })).status, 200);
  assert.equal(getClaimFollow(f.store.db, { roomId: "commons", memberId: "owner", claimId: "c1" }).unreadCount, 2);

  const follows = await f.call(f.ownerKey, "/work-claims/follows");
  assert.equal(follows.status, 200);
  assert.deepEqual(follows.value.totals, { followedClaims: 1, unreadClaims: 1, unreadEvents: 2, mentions: 0 });
  assert.equal(follows.value.follows[0].claimId, "c1");

  const muted = await f.call(f.ownerKey, "/work-claims/c1/follow", { policy: "mute" });
  assert.equal(muted.status, 200);
  assert.equal(muted.value.follow.policy, "mute");
  assert.equal((await f.call(f.aliceKey, "/work-claims/c1/renew", { leaseHours: 2 })).status, 200);
  assert.equal(getClaimFollow(f.store.db, { roomId: "commons", memberId: "owner", claimId: "c1" }).unreadCount, 2,
    "muted: the renewal accrues nothing");

  assert.equal((await f.call(f.ownerKey, "/work-claims/c1/follow", { policy: "follow" })).status, 200);
  const read = await f.call(f.ownerKey, "/work-claims/c1/follow-read", {});
  assert.equal(read.status, 200);
  assert.equal(read.value.follow.unreadCount, 0);
  assert.ok(read.value.follow.lastReadSeq >= read.value.follow.lastEventSeq);

  const bad = await f.call(f.ownerKey, "/work-claims/c1/follow", { policy: "loud" });
  assert.equal(bad.status, 422);
});

test("door: naming a reviewer by rev- tag follows them via review-assignment", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "c2", title: "Needs review", tags: ["rev-verifier"] })).status, 201);
  const record = getClaimFollow(f.store.db, { roomId: "commons", memberId: "verifier", claimId: "c2" });
  assert.equal(record.createdVia, "review-assignment");
  assert.equal(record.unreadCount, 1, "the assignment event is the reviewer's first unread");
});
