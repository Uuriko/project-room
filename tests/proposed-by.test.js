import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_TYPES as T, PERMISSIONS, applyEvent, emptyRoomState, event, replay } from "../src/events.js";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Return-brief wiring, disposition 5557850637 decision 2: proposedById derives from the
// AUTHORITATIVE EVENT ENVELOPE (incoming.actorId on work.proposed). It is never duplicated
// into event data and never inferred from the source message's author. Historical replay
// recovers it wherever the envelope exists; only genuinely absent provenance renders unknown.

const roomEvents = () => [
  event({ type: T.ROOM_CREATED, actorId: "owner", roomId: "commons", data: { roomId: "commons", ownerId: "owner", title: "t", purpose: "p" } }),
  event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", data: { memberId: "owner", displayName: "owner", kind: "human", permissions: [...PERMISSIONS] } }),
  event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work", "complete_work"] } })
];
const propose = (actorId, extra = {}) => event({ type: T.WORK_PROPOSED, actorId, roomId: "commons", data: { workItemId: "w1", title: "Review", definitionOfDone: "done", accountableMemberId: "human", ...extra } });

test("replay recovers proposedById from the envelope actorId, distinct from the accountable member", () => {
  const state = replay([...roomEvents(), propose("owner")]);
  assert.equal(state.workItems.w1.accountableMemberId, "human");
  assert.equal(state.workItems.w1.proposedById, "owner"); // the proposer is the envelope actor, not the accountable member
});

test("a forged proposer inside the payload is rejected at the command boundary and ignored by the reducer", () => {
  // The reducer must never read a proposer out of data: the source pin below proves no such
  // read exists, and the command schema rejects the unexpected field end-to-end.
  const directory = mkdtempSync(join(tmpdir(), "project-room-proposedby-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work"] } });
    assert.throws(
      () => store.command(owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "w1", title: "Review", definitionOfDone: "done", accountableMemberId: "human", proposedById: "mallory" } }),
      /Unexpected field: proposedById/
    );
    assert.equal(store.snapshot(owner, "commons").state.workItems.w1, undefined); // nothing slipped through
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("genuinely absent provenance stays unknown - no later event fabricates a proposer", () => {
  const state = replay([...roomEvents(), propose("owner")]);
  delete state.workItems.w1.proposedById; // a pre-field legacy projection row has no provenance
  const later = applyEvent(state, event({ type: T.MESSAGE_POSTED, actorId: "human", roomId: "commons", data: { body: "any update" } }));
  assert.equal(Object.hasOwn(later.workItems.w1, "proposedById"), false); // still unknown, never back-filled from other actors
});

test("source pin: proposedById is assigned from the envelope only", () => {
  const src = readFileSync(new URL("../src/events.js", import.meta.url), "utf8")
    .split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  assert.match(src, /proposedById:\s*incoming\.actorId/);
  assert.equal(src.includes("data.proposedById"), false);
});

test("reopening a pre-upgrade database repairs provenance from each item's own proposal envelope", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-repair-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work"] } });
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "w-legacy", title: "Legacy item", definitionOfDone: "done", accountableMemberId: "human" } });
  // Simulate the pre-upgrade persisted shape: projection row without the field, envelope intact.
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify((() => { const s = store.room("commons").state; delete s.workItems["w-legacy"].proposedById; return s; })()), "commons");
  store.close();
  store = new RoomStore(filename); // reopen: repair must run deterministically, without replaying the log
  try {
    const item = store.snapshot(owner, "commons").state.workItems["w-legacy"];
    assert.equal(item.proposedById, "owner"); // recovered from its own work.proposed envelope
    assert.notEqual(item.proposedById, item.accountableMemberId);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("reopening a pre-upgrade database separates legacy reporters from unknown producers", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-receipt-repair-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work", "complete_work"] } });
  const human = store.issueAccessKey("commons", "human");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "w-legacy-receipt", title: "Legacy receipt", definitionOfDone: "done", accountableMemberId: "human" } });
  store.command(human, "commons", { id: crypto.randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId: "w-legacy-receipt", expectedRevision: 0 } });
  store.command(human, "commons", { id: crypto.randomUUID(), type: T.WORK_COMPLETED, data: { workItemId: "w-legacy-receipt", expectedRevision: 1, summary: "v1", evidenceUrl: "https://example.com/v1", evidenceVersion: "v1", nextAction: "rework" } });
  store.command(human, "commons", { id: crypto.randomUUID(), type: T.WORK_BLOCKED, data: { workItemId: "w-legacy-receipt", expectedRevision: 2, reason: "v2 requested", nextAction: "accept v2" } });
  store.command(human, "commons", { id: crypto.randomUUID(), type: T.WORK_BLOCKER_RESOLVED, data: { workItemId: "w-legacy-receipt", expectedRevision: 3, resolution: "v2 accepted" } });
  store.command(human, "commons", { id: crypto.randomUUID(), type: T.WORK_COMPLETED, data: { workItemId: "w-legacy-receipt", expectedRevision: 4, summary: "v2", evidenceUrl: "https://example.com/v2", evidenceVersion: "v2", nextAction: "done" } });

  const state = store.room("commons").state;
  const item = state.workItems["w-legacy-receipt"];
  for (const receipt of [...item.receiptHistory, item.receipt]) {
    delete receipt.reportedById;
    receipt.producerId = "human"; // the old reducer's unsupported reporter=producer guess
    delete receipt.producerAttribution;
  }
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  store.close();

  store = new RoomStore(filename);
  try {
    const repaired = store.snapshot(human, "commons").state.workItems["w-legacy-receipt"];
    for (const receipt of [...repaired.receiptHistory, repaired.receipt]) {
      assert.equal(receipt.reportedById, "human");
      assert.equal(receipt.producerId, null);
      assert.equal(receipt.producerAttribution, "unknown");
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("reopening backfills verification independence only from explicit producer provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-independence-repair-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work", "complete_work"] } });
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "agent", displayName: "agent", kind: "agent", permissions: ["verify"] } });
  const human = store.issueAccessKey("commons", "human");
  const agent = store.issueAccessKey("commons", "agent");

  for (const [workItemId, producerId] of [["w-known-producer", "human"], ["w-unknown-producer", null]]) {
    store.command(owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId, title: workItemId, definitionOfDone: "done", accountableMemberId: "human", verifierMemberId: "agent", independentVerificationRequired: true } });
    store.command(human, "commons", { id: crypto.randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } });
    const completion = store.command(human, "commons", { id: crypto.randomUUID(), type: T.WORK_COMPLETED, data: { workItemId, expectedRevision: 1, ...(producerId ? { producerId } : {}), summary: "done", evidenceUrl: `https://example.com/${workItemId}`, evidenceVersion: "v1", nextAction: "verify" } });
    store.command(agent, "commons", { id: crypto.randomUUID(), type: T.VERIFICATION_RECORDED, data: { workItemId, expectedRevision: 2, result: "pass", completionEventId: completion.event.id, evidenceVersion: "v1", summary: "checked" } });
  }

  const state = store.room("commons").state;
  delete state.workItems["w-known-producer"].verification.independenceConfirmed;
  delete state.workItems["w-unknown-producer"].verification.independenceConfirmed;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  store.close();

  store = new RoomStore(filename);
  try {
    const repaired = store.snapshot(owner, "commons").state.workItems;
    assert.equal(repaired["w-known-producer"].verification.independenceConfirmed, true);
    assert.equal(repaired["w-unknown-producer"].verification.independenceConfirmed, false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("v1 upgrades checkpoint a conservative projection and strictly replay the v2 tail", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-v1-checkpoint-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const run = (token, type, data) => store.command(token, "commons", { id: crypto.randomUUID(), type, data });
  run(owner, T.MEMBER_ADDED, { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] });
  run(owner, T.MEMBER_ADDED, { memberId: "agent", displayName: "agent", kind: "agent", permissions: ["verify"] });
  const human = store.issueAccessKey("commons", "human");
  const agent = store.issueAccessKey("commons", "agent");

  run(owner, T.WORK_PROPOSED, {
    workItemId: "legacy-approved", title: "Legacy approved", definitionOfDone: "Exact evidence",
    accountableMemberId: "human", verifierMemberId: "agent", independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner"
  });
  run(human, T.WORK_ACCEPTED, { workItemId: "legacy-approved", expectedRevision: 0 });
  const approvedCompletion = run(human, T.WORK_COMPLETED, {
    workItemId: "legacy-approved", expectedRevision: 1, producerId: "human", summary: "v1 result",
    evidenceUrl: "https://example.com/legacy-approved", evidenceVersion: "v1", nextAction: "verify"
  });
  run(agent, T.VERIFICATION_RECORDED, {
    workItemId: "legacy-approved", expectedRevision: 2, result: "pass",
    completionEventId: approvedCompletion.event.id, evidenceVersion: "v1", summary: "passed"
  });
  run(owner, T.OWNER_DECISION_RECORDED, {
    workItemId: "legacy-approved", expectedRevision: 3, decision: "approved",
    completionEventId: approvedCompletion.event.id, evidenceVersion: "v1", reason: "accepted under v1"
  });

  run(owner, T.WORK_PROPOSED, {
    workItemId: "legacy-blocked", title: "Legacy blocked", definitionOfDone: "A result",
    accountableMemberId: "human", independentVerificationRequired: false,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner"
  });
  run(human, T.WORK_ACCEPTED, { workItemId: "legacy-blocked", expectedRevision: 0 });
  const blockedCompletion = run(human, T.WORK_COMPLETED, {
    workItemId: "legacy-blocked", expectedRevision: 1, summary: "done",
    evidenceUrl: "https://example.com/legacy-blocked", evidenceVersion: "v1", nextAction: "decide"
  });
  run(owner, T.OWNER_DECISION_RECORDED, {
    workItemId: "legacy-blocked", expectedRevision: 2, decision: "approved",
    completionEventId: blockedCompletion.event.id, evidenceVersion: "v1", reason: "accepted"
  });
  run(human, T.WORK_BLOCKED, {
    workItemId: "legacy-blocked", expectedRevision: 3, reason: "rework", nextAction: "revise"
  });

  run(owner, T.WORK_PROPOSED, {
    workItemId: "legacy-valid", title: "Legacy valid approval", definitionOfDone: "A result",
    accountableMemberId: "human", independentVerificationRequired: false,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner"
  });
  run(human, T.WORK_ACCEPTED, { workItemId: "legacy-valid", expectedRevision: 0 });
  const validCompletion = run(human, T.WORK_COMPLETED, {
    workItemId: "legacy-valid", expectedRevision: 1, summary: "done",
    evidenceUrl: "https://example.com/legacy-valid", evidenceVersion: "v1", nextAction: "decide"
  });
  run(owner, T.OWNER_DECISION_RECORDED, {
    workItemId: "legacy-valid", expectedRevision: 2, decision: "approved",
    completionEventId: validCompletion.event.id, evidenceVersion: "v1", reason: "still valid under v2"
  });

  run(owner, T.WORK_PROPOSED, {
    workItemId: "legacy-forged-approval", title: "Forged legacy approval", definitionOfDone: "A result",
    accountableMemberId: "human", independentVerificationRequired: false,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner"
  });
  run(human, T.WORK_ACCEPTED, { workItemId: "legacy-forged-approval", expectedRevision: 0 });
  const forgedCompletion = run(human, T.WORK_COMPLETED, {
    workItemId: "legacy-forged-approval", expectedRevision: 1, summary: "done",
    evidenceUrl: "https://example.com/legacy-forged", evidenceVersion: "v1", nextAction: "decide"
  });
  run(owner, T.OWNER_DECISION_RECORDED, {
    workItemId: "legacy-forged-approval", expectedRevision: 2, decision: "approved",
    completionEventId: forgedCompletion.event.id, evidenceVersion: "v1", reason: "real event"
  });

  run(owner, T.WORK_PROPOSED, {
    workItemId: "legacy-write", title: "Legacy write", definitionOfDone: "A write",
    accountableMemberId: "human", mode: "write"
  });
  run(human, T.WORK_ACCEPTED, { workItemId: "legacy-write", expectedRevision: 0 });
  run(human, T.CLAIM_ACQUIRED, {
    workItemId: "legacy-write", expectedRevision: 1, repository: "Uuriko/project-room",
    ref: "legacy/write", paths: ["src/app.js"], expiresAt: new Date(Date.now() + 3600000).toISOString()
  });
  run(owner, T.WORK_PROPOSED, {
    workItemId: "legacy-replacement", title: "Replacement", definitionOfDone: "A safer write",
    accountableMemberId: "human"
  });
  run(owner, T.WORK_SUPERSEDED, {
    workItemId: "legacy-write", expectedRevision: 2,
    supersededByWorkItemId: "legacy-replacement", reason: "replace it"
  });

  // Recreate the exact v1 persistence semantics while leaving the authoritative event
  // envelopes in place: reporters were guessed as producers, independence was implicit,
  // approvals were not retired on rework, and supersession did not retire a write claim.
  const legacy = store.room("commons").state;
  for (const workItemId of ["legacy-approved", "legacy-blocked", "legacy-valid", "legacy-forged-approval"]) {
    const receipt = legacy.workItems[workItemId].receipt;
    delete receipt.reportedById;
    delete receipt.producerAttribution;
    receipt.producerId = "human";
  }
  delete legacy.workItems["legacy-approved"].verification.independenceConfirmed;
  const blocked = legacy.workItems["legacy-blocked"];
  const retiredBlockedApproval = blocked.decisionHistory.pop();
  blocked.decision = Object.fromEntries(Object.entries(retiredBlockedApproval)
    .filter(([key]) => !["historical", "invalidatedByEventId", "invalidatedReason"].includes(key)));
  const legacyClaim = legacy.workItems["legacy-write"].claim;
  legacyClaim.status = "active";
  delete legacyClaim.supersededAt;
  legacy.workItems["legacy-write"].supersededBy = "legacy-write"; // v1 allowed an invalid self-link
  Object.assign(legacy.workItems["legacy-forged-approval"].decision, {
    actorId: "agent",
    completionEventId: "forged-completion",
    reason: "forged projection"
  });

  for (const completion of [approvedCompletion.event, blockedCompletion.event, validCompletion.event, forgedCompletion.event]) {
    const body = JSON.parse(store.db.prepare("SELECT body FROM events WHERE id=?").get(completion.id).body);
    delete body.data.producerId;
    store.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(body), completion.id);
  }
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(legacy));
  store.db.exec("DROP TABLE projection_checkpoints; PRAGMA user_version=1");
  const eventBodies = store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all().map(row => row.body);
  const legacyEvents = eventBodies.map(body => JSON.parse(body));
  store.close();

  assert.throws(() => replay(legacyEvents), /confirmed producer independence/,
    "strict v2 replay must never silently accept a v1-only approval");
  store = new RoomStore(filename);
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.deepEqual(store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all().map(row => row.body), eventBodies,
      "migration leaves the append-only event bodies byte-identical");
    const repaired = store.room("commons");
    const approved = repaired.state.workItems["legacy-approved"];
    assert.equal(approved.receipt.reportedById, "human");
    assert.equal(approved.receipt.producerId, null);
    assert.equal(approved.receipt.producerAttribution, "unknown");
    assert.equal(approved.verification.independenceConfirmed, false);
    assert.equal(approved.decision, null);
    assert.equal(approved.decisionHistory.at(-1).invalidatedByRepair, "producer_independence_unconfirmed");
    const repairedBlocked = repaired.state.workItems["legacy-blocked"];
    assert.equal(repairedBlocked.decision, null);
    assert.equal(repairedBlocked.decisionHistory.at(-1).invalidatedByRepair, "approval_not_current");
    assert.equal(repairedBlocked.decisionHistory.at(-1).invalidatedState, "blocked");
    assert.equal(repaired.state.workItems["legacy-valid"].decision.decision, "approved",
      "an approval that does not require independent verification survives migration");
    const forged = repaired.state.workItems["legacy-forged-approval"];
    assert.equal(forged.decision, null);
    assert.equal(forged.decisionHistory.at(-1).invalidatedByRepair, "approval_provenance_unconfirmed");
    assert.equal(repaired.state.workItems["legacy-write"].claim.status, "superseded");
    assert.ok(repaired.state.workItems["legacy-write"].claim.supersededAt);
    assert.equal(repaired.state.workItems["legacy-write"].supersededBy, null);
    assert.equal(repaired.state.workItems["legacy-write"].supersessionRepair.previousTargetId, "legacy-write");
    const brief = store.returnBrief(human, "commons", {});
    assert.equal(brief.current.workInvolvingMe.some(item => item.workItemId === "legacy-write"), false);
    assert.equal(brief.current.needsAttention.some(item => item.workItemId === "legacy-write"), false);

    const checkpoint = store.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id='commons'").get();
    assert.equal(checkpoint.sequence, repaired.sequence);
    assert.deepEqual(JSON.parse(checkpoint.projection), repaired.state);
    assert.deepEqual(store.rebuildProjection("commons"), repaired);

    store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body: "strict v2 tail" } });
    assert.deepEqual(store.rebuildProjection("commons"), store.room("commons"));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the v1 projection, checkpoint, and version marker roll back together", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-upgrade-rollback-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  try {
    store.initialize(initialRoom());
    const originalProjection = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
    const originalEvents = store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all().map(row => row.body);
    store.db.exec("DROP TABLE projection_checkpoints; PRAGMA user_version=1");
    store.db.prepare("INSERT INTO rooms(id,sequence,projection) VALUES('z-malformed',0,'{')").run();

    assert.throws(() => store.repairProjectionProvenance({ upgradeV1: true }), SyntaxError);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projection_checkpoints'").get(), undefined);
    assert.equal(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection, originalProjection);
    assert.deepEqual(store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all().map(row => row.body), originalEvents);

    store.db.prepare("DELETE FROM rooms WHERE id='z-malformed'").run();
    store.repairProjectionProvenance({ upgradeV1: true });
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM projection_checkpoints").get().count, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("fresh databases use schema v2 and newer unknown schemas fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-schema-version-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projection_checkpoints'").get());
  store.db.exec("PRAGMA user_version=3");
  store.close();
  assert.throws(() => new RoomStore(filename), /schema is newer/);
  rmSync(directory, { recursive: true, force: true });
});

test("an item with no authoritative proposal envelope stays honestly unknown after reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-repair-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  // Inject an imported legacy item with NO proposal envelope anywhere in the log.
  const state = store.room("commons").state;
  state.workItems["w-imported"] = { id: "w-imported", title: "Imported", state: "proposed", accountableMemberId: "owner" };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  store.close();
  store = new RoomStore(filename);
  try {
    const item = store.snapshot(owner, "commons").state.workItems["w-imported"];
    assert.equal(Object.hasOwn(item, "proposedById"), false); // repair fabricates nothing
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
