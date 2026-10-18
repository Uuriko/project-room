// PR-1 (HOT-PATH): the receipt re-projection gate.
//
// Before the gate, every successful command in a receipts-opted-in room
// deleted and rebuilt ALL of the room's public_receipts rows inside the
// write transaction (1 DELETE + one INSERT per receipt-bearing claim, plus
// the listing touch): at 100 claims a plain chat post cost 102
// public_receipts writes. The gate fingerprints the inputs the projection
// reads and skips the rebuild when they have not moved.
//
// Correctness is the gate, not the write count: after every step of a
// mixed command sequence, the rows the gated path produced must be
// byte-identical to a forced full rebuild (syncRoomPublication with an
// authoritative previous=null), across opt-in/opt-out transitions, claim
// state changes, verification-tier changes, work-item completions and
// member credit changes.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { syncRoomPublication } from "../server/public-read-model.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;

function makeStore() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("gate-room"));
  const ownerKey = store.issueAccessKey("gate-room", "owner");
  return { store, ownerKey };
}

const cmd = (store, key, id, type, data) => store.command(key, "gate-room", { id, type, data });

function rows(store) {
  return store.db.prepare(`SELECT id, title, source, origin_room_id, room_id, room_title, agents_json,
    humans_json, pull_request, merged_at, verification_state, hashes_json, at, start_href
    FROM public_receipts ORDER BY id`).all();
}

// The gated state must equal a forced full rebuild, row for row.
function assertEquivalentToFullRebuild(store) {
  const before = rows(store);
  const state = store.room("gate-room").state;
  syncRoomPublication(store, { roomId: "gate-room", state, previous: null, auth: null });
  assert.deepEqual(rows(store), before, "gated projection differs from a forced full rebuild");
}

// Count write statements whose SQL touches a public_receipts table.
function countReceiptWrites(store, fn) {
  let writes = 0;
  const native = store.db.prepare.bind(store.db);
  store.db.prepare = (sql, ...rest) => {
    const stmt = native(sql, ...rest);
    const text = String(sql);
    if (!/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(text) || !/public_receipts/i.test(text)) return stmt;
    const run = stmt.run.bind(stmt);
    stmt.run = (...args) => { writes++; return run(...args); };
    return stmt;
  };
  try { fn(); } finally { store.db.prepare = native; }
  return writes;
}

function mergedClaim(id, title = `Claim ${id}`, pr = 7) {
  return {
    id, title, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: "2026-10-01T00:00:00.000Z" },
      { action: "state:done", agentId: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: `https://github.com/Uuriko/project-room/pull/${pr}`, outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

test("a chat post in an opted-in room with 100 claims performs at most 2 public_receipts writes", () => {
  const { store, ownerKey } = makeStore();
  cmd(store, ownerKey, "opt-in", "room.public_receipts_set", { enabled: true });
  for (let i = 0; i < 100; i++) store.workClaims.set("gate-room", mergedClaim(`claim-${i}`, `Claim ${i}`, 1000 + i));
  assert.equal(rows(store).length, 100);
  const writes = countReceiptWrites(store, () =>
    cmd(store, ownerKey, "chat-1", "message.posted", { messageId: "chat-1", body: "hello" }));
  assert.ok(writes <= 2, `chat post wrote public_receipts ${writes} times (gate target <= 2)`);
  assert.equal(rows(store).length, 100);
  assertEquivalentToFullRebuild(store);
  store.close();
});

test("gated projection stays identical to a full rebuild across a mixed command sequence", () => {
  const { store, ownerKey } = makeStore();
  cmd(store, ownerKey, "add-ada", "member.added", { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work", "complete_work"] });
  const adaKey = store.issueAccessKey("gate-room", "ada");
  const step = label => assertEquivalentToFullRebuild(store, label);

  cmd(store, ownerKey, "opt-in", "room.public_receipts_set", { enabled: true });
  step("opt-in with no claims");

  // Result-mode finishes at both verification tiers, plus a merged claim.
  store.workClaims.set("gate-room", {
    id: "verified-result", title: "Verified result", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "distinct_member", reviewedBy: "owner",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T10:00:00.000Z" }],
    pullRequest: null, blobs: [HASH], updatedAt: "2026-10-02T10:00:00.000Z",
  });
  step("verified result claim set");
  store.workClaims.set("gate-room", {
    id: "self-result", title: "Self attested", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "self_attested",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T11:00:00.000Z" }],
    pullRequest: null, blobs: [], updatedAt: "2026-10-02T11:00:00.000Z",
  });
  step("self-attested claim set");
  const tiers = Object.fromEntries(rows(store).map(row => [row.title, row.verification_state]));
  assert.equal(tiers["Verified result"], "verified");
  assert.equal(tiers["Self attested"], "self_attested");

  // Non-receipt commands: rows must not move, and the gate must skip.
  const chatWrites = countReceiptWrites(store, () =>
    cmd(store, ownerKey, "chat-1", "message.posted", { messageId: "chat-1", body: "just chatting" }));
  assert.ok(chatWrites <= 2, `chat post wrote ${chatWrites}`);
  step("chat post");

  // A claim state change re-projects: the verified claim's tier flips when
  // its recorded reviewer becomes the worker herself.
  store.workClaims.set("gate-room", {
    id: "verified-result", title: "Verified result", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "distinct_member", reviewedBy: "ada",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T10:00:00.000Z" }],
    pullRequest: null, blobs: [HASH], updatedAt: "2026-10-03T10:00:00.000Z",
  });
  assert.equal(rows(store).find(row => row.title === "Verified result")?.verification_state, "self_attested");
  step("verification tier change");

  // A claim that stops projecting (reopened) loses its row.
  store.workClaims.set("gate-room", { ...mergedClaim("self-result", "Self attested"), state: "working", owner: "ada", pullRequest: null });
  assert.equal(rows(store).some(row => row.title === "Self attested"), false);
  step("claim reopened");

  // A work-item completion through the command door projects a wir_ row.
  cmd(store, ownerKey, "propose-1", "work.proposed", { workItemId: "item-1", title: "Board work", definitionOfDone: "Done", accountableMemberId: "ada" });
  step("work proposed");
  const revisionOf = () => store.room("gate-room").state.workItems["item-1"].revision;
  cmd(store, adaKey, "accept-1", "work.accepted", { workItemId: "item-1", expectedRevision: revisionOf() });
  cmd(store, adaKey, "start-1", "work.started", { workItemId: "item-1", expectedRevision: revisionOf() });
  const body = "the exact in-room result";
  const posted = cmd(store, adaKey, "post-evidence", "message.posted", { messageId: "evidence-1", workItemId: "item-1", body });
  cmd(store, adaKey, "complete-1", "work.completed", {
    workItemId: "item-1", expectedRevision: revisionOf(), summary: "in-room result", nextAction: "Review",
    evidenceKind: "room_text", evidenceMessageId: "evidence-1", evidenceMessageEventId: posted.event.id,
    previousCompletionEventId: null, producerId: null,
    evidenceVersion: `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
  });
  assert.equal(rows(store).some(row => row.source === "work-item" && row.title === "Board work"), true);
  step("work completed");

  // A member credit change (deactivation) re-projects the credits.
  const adaRevision = store.room("gate-room").state.members.ada.revision;
  cmd(store, ownerKey, "deactivate-ada", "member.access_changed", { memberId: "ada", expectedMemberRevision: adaRevision, active: false, permissions: [] });
  step("member deactivated");

  // Opt-out deletes every projected row; opt-in restores them exactly.
  cmd(store, ownerKey, "opt-out", "room.public_receipts_set", { enabled: false });
  assert.equal(rows(store).length, 0);
  step("opt-out");
  cmd(store, ownerKey, "chat-2", "message.posted", { messageId: "chat-2", body: "while opted out" });
  assert.equal(rows(store).length, 0);
  cmd(store, ownerKey, "opt-in-2", "room.public_receipts_set", { enabled: true });
  assert.ok(rows(store).length > 0);
  step("opt-in again");

  // Deleting a claim through the registry removes its row.
  const victim = rows(store).find(row => row.source === "work-claim");
  assert.ok(victim, "a work-claim row exists to delete");
  const claimId = store.workClaims.list("gate-room").find(claim => victim.title === claim.title)?.id;
  store.workClaims.delete("gate-room", claimId);
  assert.equal(rows(store).some(row => row.id === victim.id), false);
  step("claim deleted");
  store.close();
});
