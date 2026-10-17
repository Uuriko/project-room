// Decision #10 migration core (server/work-item-board.mjs): the mapping
// every legacy workItem -> board claim follows, the idempotent backfill,
// and the AvailableWork shadow-read equivalence the consumer cutover
// gates on. Pure mapping tests use synthetic items/events in exactly the
// shapes tests/workitems-migration-census.test.js pins; store tests run
// the real RoomStore + command flow.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  boardClaimId, boardClaimForWorkItem, planWorkItemBoardBackfill,
  diffRoomWorkItems, sameClaimRow,
} from "../server/work-item-board.mjs";
import { availableWorkInRoom } from "../server/available-work.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { updateWork } from "../server/work-claims.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const T0 = "2026-10-01T00:00:00.000Z";
const H = 3600e3;
const at = ms => new Date(Date.parse(T0) + ms).toISOString();
const NOW = Date.parse(T0) + 10 * H;

let eventSeq = 0;
const ev = (type, atMs, actorId, data) => ({ id: `ev-${++eventSeq}`, type, actorId, at: at(atMs), data });

function item(overrides = {}) {
  return {
    id: "task-a", title: "Task A", state: "proposed", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
    ownerDecisionRequired: false, independentVerificationRequired: false,
    definitionOfDone: "done means done", labels: [], mode: "write", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, claim: null, supersededBy: null,
    ...overrides,
  };
}
const liveClaimFields = (overrides = {}) => ({
  holderId: "worker", repository: "Uuriko/project-room", ref: "main",
  paths: ["server/**"], status: "active", acquiredAt: at(2 * H), expiresAt: at(30 * H),
  ...overrides,
});
const factsFor = events => {
  // boardClaimForWorkItem consumes the facts object workItemEventFacts
  // builds; here a single item's events, keyed lookup included.
  const byEventId = new Map(events.map(event => [event.id, event]));
  return { events, byEventId, pullRequests: [], blocks: [], supersedeEvents: events.filter(e => e.type === "work.superseded") };
};

test("boardClaimId: the id mapping is pinned character-for-character (existing cards and receipt ids depend on it)", () => {
  // Expectations generated from the pre-migration mirror implementation
  // (the function moved verbatim to server/work-item-board.mjs in step 1
  // and the mirror was cut in step 2 — these literals are now the pin).
  const samples = new Map([
    ["task-a", "task-a"],           // board-safe: passes through unchanged
    ["task.1", "_etask_p1"],
    ["task:1", "_etask_c1"],
    ["task_1", "task_1"],           // "_" is board-safe: passes through
    ["tâche.2", "_et_xe2_che_p2"],  // non-ASCII: code-point escape
    ["", "workitem"],
    ["UPPER_case-9", "UPPER_case-9"],
    ["café:menu.1", "_ecaf_xe9__cmenu_p1"],
  ]);
  for (const [input, expected] of samples) assert.equal(boardClaimId(input), expected, input);
  assert.equal(boardClaimId("x".repeat(128)), "x".repeat(128)); // at the limit: still a pass-through
  assert.match(boardClaimId("a".repeat(200)), /^_h[0-9a-f]{40}$/); // over the limit: hash fallback
  assert.equal(boardClaimId("a".repeat(200)), "_hc2a908d98f5df987ade41b5fce213067efbcc21e");
});

test("mapping: proposed items map to NO card (unaccepted work must not become board-claimable)", () => {
  // The board's availability predicate offers every usable unclaimed
  // claim; the work-item door offers only ACCEPTED items. A card for a
  // merely-proposed item would silently retire the acceptance gate.
  assert.equal(boardClaimForWorkItem(item(), factsFor([ev("work.proposed", 0, "owner", { workItemId: "task-a" })]), { nowMs: NOW }), null);
  const { rows } = planWorkItemBoardBackfill({ items: [item()], events: [], existing: new Map(), nowMs: NOW });
  assert.equal(rows.size, 0);
});

test("mapping: accepted (unclaimed) -> unclaimed card carrying the item's identity", () => {
  const row = boardClaimForWorkItem(item({ state: "accepted" }), factsFor([ev("work.proposed", 0, "owner", { workItemId: "task-a" })]), { nowMs: NOW });
  assert.equal(row.id, "task-a");
  assert.equal(row.state, "unclaimed");
  assert.equal(row.owner, null);
  assert.equal(row.title, "Task A");
  assert.equal(row.workItemId, "task-a");
  assert.equal(row.kind, "work");
  assert.equal(row.reviewPolicy, null);
  assert.deepEqual(row.history.map(stamp => stamp.action), ["created"]);
  assert.equal(row.updatedAt, T0);
});

test("mapping: accepted with a live claim -> claimed with the claim's scope and lease", () => {
  const claimEvent = ev("claim.acquired", 2 * H, "worker", {
    workItemId: "task-a", pullRequests: ["https://github.com/Uuriko/project-room/pull/7", "https://example.com/not-a-pr"],
  });
  const facts = factsFor([ev("work.proposed", 0, "owner", { workItemId: "task-a" }), claimEvent]);
  facts.pullRequests = claimEvent.data.pullRequests;
  const row = boardClaimForWorkItem(item({ state: "accepted", claim: liveClaimFields(), labels: ["migration"] }), facts, { nowMs: NOW });
  assert.equal(row.state, "claimed");
  assert.equal(row.owner, "worker");
  assert.equal(row.claimedAt, at(2 * H));
  assert.equal(row.leaseExpiresAt, at(30 * H));
  assert.deepEqual(row.files, ["server/**"]);
  assert.equal(row.repo, "Uuriko/project-room");
  assert.equal(row.branch, "main");
  assert.deepEqual(row.tags, ["migration"]);
  // The engine drops non-GitHub pull links; the lone PR is normalized.
  assert.equal(row.pullRequests.length, 1);
  assert.equal(row.pullRequests[0].repo, "Uuriko/project-room");
  assert.equal(row.pullRequests[0].number, 7);
  assert.deepEqual(row.history.map(stamp => stamp.action), ["created", "claimed"]);
});

test("mapping: an expired lease reads as unclaimed with the scope cleared", () => {
  const row = boardClaimForWorkItem(
    item({ state: "accepted", claim: liveClaimFields({ expiresAt: at(5 * H) }) }),
    factsFor([]), { nowMs: NOW });
  assert.equal(row.state, "unclaimed");
  assert.equal(row.owner, null);
  assert.deepEqual(row.files, []);
  assert.equal(row.leaseExpiresAt, null);
});

test("mapping: working read-mode item (no claim exists) -> in_progress under its accountable member", () => {
  const facts = factsFor([
    ev("work.proposed", 0, "owner", { workItemId: "task-a" }),
    ev("work.started", 3 * H, "worker", { workItemId: "task-a" }),
  ]);
  const row = boardClaimForWorkItem(item({ state: "working", mode: "read" }), facts, { nowMs: NOW });
  assert.equal(row.state, "in_progress");
  assert.equal(row.owner, "worker");
  assert.equal(row.claimedAt, at(3 * H));
  assert.equal(row.leaseExpiresAt, null);
});

test("mapping: blocked -> blocked with the blocker as premise flag", () => {
  const blockEvent = ev("work.blocked", 4 * H, "worker", { workItemId: "task-a", reason: "waiting on API" });
  const facts = factsFor([ev("work.proposed", 0, "owner", { workItemId: "task-a" }), blockEvent]);
  const blocked = item({
    state: "blocked", claim: liveClaimFields(),
    blocker: { reason: "waiting on API", nextAction: "ping them", eventId: blockEvent.id },
  });
  const row = boardClaimForWorkItem(blocked, facts, { nowMs: NOW });
  assert.equal(row.state, "blocked");
  assert.equal(row.owner, "worker");
  assert.deepEqual(row.premiseFlag, { premiseId: "task-a", reason: "waiting on API", by: "worker", at: at(4 * H) });
  assert.ok(row.history.some(stamp => stamp.action === "state:blocked"));
});

test("mapping: completed -> done with receipt attestation, evidence and the done stamp receipts read", () => {
  const completeEvent = ev("work.completed", 6 * H, "worker", { workItemId: "task-a" });
  const verifyEvent = ev("verification.recorded", 7 * H, "owner", { workItemId: "task-a" });
  const blob = `sha256:${"ab".repeat(32)}`;
  const done = item({
    state: "completed", claim: liveClaimFields(), verifierMemberId: "owner",
    receipt: {
      reportedById: "worker", producerId: "worker", summary: "Shipped it",
      evidenceUrl: "https://example.com/delivery", evidenceVersion: blob, eventId: completeEvent.id,
    },
    verification: { verifierId: "owner", result: "pass", summary: "Checks out", eventId: verifyEvent.id },
  });
  const row = boardClaimForWorkItem(done, factsFor([completeEvent, verifyEvent]), { nowMs: NOW });
  assert.equal(row.state, "done");
  assert.equal(row.owner, "worker");
  assert.deepEqual(row.attestations, [{ memberId: "worker", at: at(6 * H), note: "Shipped it" }]);
  assert.deepEqual(row.evidenceRefs, ["https://example.com/delivery"]);
  assert.deepEqual(row.blobs, [blob]);
  assert.deepEqual(row.reviews, [{ memberId: "owner", verdict: "approve", summary: "Checks out", url: null, at: at(7 * H) }]);
  assert.equal(row.reviewedBy, "owner");
  const doneStamp = row.history.findLast(stamp => stamp.action === "state:done");
  assert.equal(doneStamp.note, "Shipped it"); // the receipts surface reads this note as the summary
  assert.equal(doneStamp.at, at(6 * H));
});

test("mapping: a failed verification is a changes_requested review; reviewPolicy follows the item's gates", () => {
  const failed = item({
    state: "blocked", verifierMemberId: "owner", independentVerificationRequired: true,
    verification: { verifierId: "owner", result: "fail", summary: "Missing tests", eventId: "ev-x" },
    blocker: { reason: "Missing tests", nextAction: "add tests", eventId: "ev-x" },
  });
  const row = boardClaimForWorkItem(failed, factsFor([]), { nowMs: NOW });
  assert.equal(row.reviews[0].verdict, "changes_requested");
  assert.equal(row.reviewPolicy, "independent_principal");
  const distinct = boardClaimForWorkItem(item({ state: "accepted", verifierMemberId: "owner" }), factsFor([]), { nowMs: NOW });
  assert.equal(distinct.reviewPolicy, "distinct_member");
});

test("mapping: superseded -> closed with supersededBy and a supersede chain link", () => {
  const supersede = ev("work.superseded", 8 * H, "owner", { workItemId: "task-a", supersededByWorkItemId: "task-b", reason: "replanned" });
  const row = boardClaimForWorkItem(
    item({ state: "superseded", supersededBy: "task-b", claim: liveClaimFields({ status: "superseded" }) }),
    factsFor([supersede]), { nowMs: NOW });
  assert.equal(row.state, "closed");
  assert.equal(row.supersededBy, "task-b");
  assert.deepEqual(row.chain, [{ kind: "supersede", targetId: "task-b", at: at(8 * H), actorId: "owner", note: "replanned" }]);
});

test("plan: successor lineage matches the mirror's cards (dependsOn on the successor, phantom when cardless)", () => {
  const source = item({ id: "task-a", state: "superseded", supersededBy: "task-b" });
  const supersede = ev("work.superseded", 8 * H, "owner", { workItemId: "task-a", supersededByWorkItemId: "task-b", reason: "replanned" });
  // Target is not a work item in the room: phantom card, dependsOn [source].
  const phantomPlan = planWorkItemBoardBackfill({ items: [source], events: [supersede], existing: new Map(), nowMs: NOW });
  const phantom = phantomPlan.rows.get("task-b");
  assert.ok(phantom);
  assert.equal(phantom.title, "task-b");
  assert.equal(phantom.workItemId, "task-b");
  assert.deepEqual(phantom.dependsOn, ["task-a"]);
  // Target is a PROPOSED work item (no mapped row of its own): the
  // mirror still created the successor card at supersede time.
  const proposedPlan = planWorkItemBoardBackfill({ items: [source, item({ id: "task-b", state: "proposed" })], events: [supersede], existing: new Map(), nowMs: NOW });
  assert.equal(proposedPlan.rows.get("task-b").title, "task-b");
  assert.deepEqual(proposedPlan.rows.get("task-b").dependsOn, ["task-a"]);
  // Target is an ACCEPTED work item: its mapped card gains the lineage
  // dependsOn (and keeps its own title).
  const target = item({ id: "task-b", title: "Replacement", state: "accepted" });
  const realPlan = planWorkItemBoardBackfill({ items: [source, target], events: [supersede], existing: new Map(), nowMs: NOW });
  assert.deepEqual(realPlan.rows.get("task-b").dependsOn, ["task-a"]);
  assert.equal(realPlan.rows.get("task-b").title, "Replacement");
  // And once the phantom exists, the target's own mapping preserves the
  // dependsOn while replacing the phantom title with the item's title.
  const grown = boardClaimForWorkItem(target, factsFor([]), { nowMs: NOW, existing: phantom });
  assert.equal(grown.title, "Replacement");
  assert.deepEqual(grown.dependsOn, ["task-a"]);
  // Handoff: "-next" phantom titled by the FIRST handoff's nextAction.
  const handed = item({ id: "task-c", state: "working", claim: liveClaimFields(), handoff: { nextAction: "Second step" } });
  const handoff1 = ev("work.handoff_recorded", 5 * H, "worker", { workItemId: "task-c", nextAction: "First step" });
  const handoffPlan = planWorkItemBoardBackfill({ items: [handed], events: [handoff1], existing: new Map(), nowMs: NOW });
  assert.equal(handoffPlan.rows.get("task-c-next").title, "First step");
  assert.deepEqual(handoffPlan.rows.get("task-c-next").dependsOn, ["task-c"]);
  assert.equal(handoffPlan.rows.get("task-c").chain[0].kind, "handoff");
});

test("plan: board-native fields survive reconciliation; diverged rows are reported, never overwritten", () => {
  const claimed = item({ state: "accepted", claim: liveClaimFields(), labels: ["item-label"] });
  const boardNativeReview = { memberId: "owner", verdict: "comment", summary: "board note", url: null, at: at(3 * H) };
  const existing = new Map([["task-a", {
    ...boardClaimForWorkItem(claimed, factsFor([]), { nowMs: NOW }),
    ci: { state: "passing" }, tags: ["board-tag"], reviews: [boardNativeReview], squadId: "squad-1",
  }]]);
  const { rows, diverged } = planWorkItemBoardBackfill({ items: [claimed], events: [], existing, nowMs: NOW });
  assert.equal(diverged.length, 0);
  const reconciled = rows.get("task-a");
  assert.deepEqual(reconciled.ci, { state: "passing" });
  assert.equal(reconciled.squadId, "squad-1");
  assert.deepEqual(new Set(reconciled.tags), new Set(["item-label", "board-tag"]));
  assert.ok(reconciled.reviews.some(review => review.summary === "board note"));

  // A live board claim held by someone the item never named: diverged.
  const foreign = new Map([["task-a", { ...boardClaimForWorkItem(claimed, factsFor([]), { nowMs: NOW }), state: "claimed", owner: "mallory" }]]);
  const foreignPlan = planWorkItemBoardBackfill({ items: [claimed], events: [], existing: foreign, nowMs: NOW });
  assert.equal(foreignPlan.rows.has("task-a"), false);
  assert.deepEqual(foreignPlan.diverged, [{ workItemId: "task-a", claimId: "task-a", boardState: "claimed", itemState: "accepted", class: "board_native" }]);
  // A board-side completion the item has not reached: diverged, and
  // board_native (no completion event / receipt proves a rework).
  const boardDone = new Map([["task-a", { ...boardClaimForWorkItem(claimed, factsFor([]), { nowMs: NOW }), state: "done" }]]);
  const boardDonePlan = planWorkItemBoardBackfill({ items: [item({ state: "working", claim: liveClaimFields() })], events: [], existing: boardDone, nowMs: NOW });
  assert.equal(boardDonePlan.diverged.length, 1);
  assert.equal(boardDonePlan.diverged[0].class, "board_native");
  assert.equal(boardDonePlan.rows.has("task-a"), false);
});

test("plan: re-planning over its own output is a fixed point (idempotency)", () => {
  const items = [
    item({ id: "task-a", state: "accepted", claim: liveClaimFields(), labels: ["x"] }),
    item({ id: "task-b", state: "superseded", supersededBy: "task-c" }),
    item({ id: "task-d", state: "working", mode: "read", handoff: { nextAction: "Next" } }),
  ];
  const events = [
    ev("work.superseded", 8 * H, "owner", { workItemId: "task-b", supersededByWorkItemId: "task-c", reason: "r" }),
    ev("work.handoff_recorded", 5 * H, "worker", { workItemId: "task-d", nextAction: "Next" }),
  ];
  const first = planWorkItemBoardBackfill({ items, events, existing: new Map(), nowMs: NOW });
  const second = planWorkItemBoardBackfill({ items, events, existing: first.rows, nowMs: NOW });
  // Every row the second plan still produces is byte-identical to the
  // first plan's (phantom successors are simply left alone once they
  // exist, so they may be absent from the second plan's write set).
  for (const [claimId, row] of second.rows) assert.ok(sameClaimRow(row, first.rows.get(claimId)), claimId);
});

test("mapping: history is capped at the engine's 200 with the overflow counted", () => {
  const events = [ev("work.proposed", 0, "owner", { workItemId: "task-a" }), ev("claim.acquired", H, "worker", { workItemId: "task-a" })];
  for (let i = 0; i < 250; i += 1) events.push(ev("claim.renewed", 2 * H + i, "worker", { workItemId: "task-a" }));
  const row = boardClaimForWorkItem(item({ state: "accepted", claim: liveClaimFields() }), factsFor(events), { nowMs: NOW });
  assert.equal(row.history.length, 200);
  assert.equal(row.historyOmitted, 52);
});

test("mapping: mapped rows are accepted by the board engine's own validator", () => {
  const row = boardClaimForWorkItem(item({ state: "accepted", claim: liveClaimFields() }), factsFor([]), { nowMs: NOW });
  const moved = updateWork(row, "worker", { state: "in_progress", now: NOW });
  assert.equal(moved.state, "in_progress");
});

// ---------------------------------------------------------------------------
// Store-level: real RoomStore, real commands, the durable registry.

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "workitems-board-"));
  const filename = join(dir, "room.sqlite");
  let store = new RoomStore(filename, { workItemBoardBackfill: "manual", ...options });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-worker", type: "member.added",
    data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] },
  });
  const workerKey = store.issueAccessKey("commons", "worker");
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const item = id => store.room("commons").state.workItems[id];
  const mutate = (key, id, type, workItemId, data = {}) =>
    send(key, id, type, { workItemId, expectedRevision: item(workItemId).revision, ...data });
  return {
    get store() { return store; },
    reopen: (reopenOptions = {}) => { store.close(); store = new RoomStore(filename, reopenOptions); },
    ownerKey, workerKey, send, item, mutate,
  };
}

function driveLifecycle(f) {
  const signEvidence = makeTestSigner(f.store);
  f.send(f.ownerKey, "propose-open", "work.proposed", {
    workItemId: "task-open", title: "Open task", definitionOfDone: "Accepted and waiting",
    accountableMemberId: "worker", mode: "read", labels: ["queue"],
  });
  f.mutate(f.workerKey, "accept-open", "work.accepted", "task-open");
  f.send(f.ownerKey, "propose-done", "work.proposed", {
    workItemId: "task-done", title: "Finished task", definitionOfDone: "Ship it",
    accountableMemberId: "worker", verifierMemberId: "owner", mode: "write", labels: ["shipped"],
  });
  f.mutate(f.workerKey, "accept-done", "work.accepted", "task-done");
  f.mutate(f.workerKey, "claim-done", "claim.acquired", "task-done", {
    repository: "Uuriko/project-room", ref: "main", paths: ["server/**"],
    expiresAt: new Date(Date.now() + 2 * H).toISOString(),
  });
  f.mutate(f.workerKey, "start-done", "work.started", "task-done");
  const text = "Delivered the thing";
  f.mutate(f.workerKey, "complete-done", "work.completed", "task-done", {
    summary: text, evidenceVersion: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    producerId: "worker", evidenceUrl: "https://example.com/delivery", nextAction: "Verify",
    signedEvidence: signEvidence(),
  });
  const receipt = f.item("task-done").receipt;
  f.mutate(f.ownerKey, "verify-done", "verification.recorded", "task-done", {
    result: "pass", completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion, summary: "Checks out",
  });
  f.send(f.ownerKey, "propose-idle", "work.proposed", {
    workItemId: "task-idle", title: "Idle proposal", definitionOfDone: "Someday",
    accountableMemberId: "worker", mode: "read",
  });
}

test("store: backfill lands every lifecycle state on the board; receipts read the migrated card", async (t) => {
  const f = fixture(t);
  driveLifecycle(f);
  // The legacy state this migration repairs, staged by wiping the board
  // rows the sync wrote: with only the (frozen) mirror's behavior, the
  // claimed item's card would still say "claimed" after completion and
  // the accepted item would have no card at all. Delete the rows and let
  // the backfill rebuild the board from projection + event log alone.
  f.store.db.prepare("DELETE FROM work_claims WHERE room_id='commons'").run();
  assert.equal(f.store.workClaims.get("commons", "task-open"), null);
  assert.equal(f.store.workClaims.get("commons", "task-done"), null);

  const report = f.store.backfillRoomWorkItemClaims("commons");
  assert.deepEqual(report.errors, []);
  assert.equal(report.items, 3);
  assert.equal(report.created, 2); // task-open + task-done rebuilt from the log alone
  assert.equal(report.updated, 0);
  assert.equal(f.store.workClaims.get("commons", "task-open").state, "unclaimed");
  // Proposed items get NO card: unaccepted work is not board-claimable.
  assert.equal(f.store.workClaims.get("commons", "task-idle"), null);
  const done = f.store.workClaims.get("commons", "task-done");
  assert.equal(done.state, "done");
  assert.equal(done.owner, "worker");
  assert.equal(done.reviewedBy, "owner");

  // The receipts surface serves the migrated completion under the same
  // receipt id format it always used: rc_<claim id> == rc_<work item id>
  // for board-safe ids.
  const helpers = {
    json: (res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const out = await handleWorkClaims({
    req: { method: "GET" }, res: {},
    url: new URL("http://x/api/rooms/commons/receipts"),
    store: f.store, roomId: "commons", auth: { member: { id: "owner", kind: "human" } },
    workClaimRoute: "receipts", workClaimId: null, helpers, registry: f.store.workClaims,
  });
  assert.equal(out.status, 200);
  const receipt = out.value.receipts.find(entry => entry.receiptId === "rc_task-done");
  assert.ok(receipt, JSON.stringify(out.value.receipts.map(entry => entry.receiptId)));
  assert.equal(receipt.summary, "Delivered the thing");
  assert.equal(receipt.createdBy, "worker");
  assert.deepEqual(receipt.tags, ["shipped"]);

  // Converged + idempotent: the diff is empty and a forced re-run
  // changes nothing.
  assert.equal(diffRoomWorkItems(f.store, "commons").converged, true);
  const again = f.store.backfillRoomWorkItemClaims("commons");
  assert.equal(again.created, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.unchanged, 2);
});

test("store: the open-time backfill runs on reopen (auto mode) and the marker makes it stick", async (t) => {
  const f = fixture(t);
  driveLifecycle(f);
  // Stage the legacy corpus: projection + event log present, board rows
  // absent (the pre-migration database shape).
  f.store.db.prepare("DELETE FROM work_claims WHERE room_id='commons'").run();
  assert.equal(f.store.workClaims.get("commons", "task-open"), null);
  f.reopen(); // default options: auto backfill at open
  assert.equal(f.store.workClaims.get("commons", "task-open").state, "unclaimed");
  assert.equal(f.store.workClaims.get("commons", "task-done").state, "done");
  const snapshot = JSON.stringify(f.store.workClaims.list("commons"));
  f.reopen();
  assert.equal(JSON.stringify(f.store.workClaims.list("commons")), snapshot);
});

test("store: AvailableWork is board-only after the flip — the board is the one availability definition", async (t) => {
  const f = fixture(t);
  driveLifecycle(f);
  // A board-native claim too: the read must carry it throughout.
  const { createWork } = await import("../server/work-claims.mjs");
  f.store.workClaims.set("commons", createWork({ id: "board-native", title: "Board native" }, { now: Date.now(), agentId: "owner" }));
  const identities = entries => new Set(entries.map(entry => {
    if (entry.source === "workItem") return entry.id;
    return f.store.workClaims.get("commons", entry.id)?.workItemId ?? entry.id;
  }));
  // With the migration in place (sync + cards present), the board-only
  // read offers exactly the available work: the accepted-unclaimed item
  // (as its board claim) and the board-native claim.
  assert.deepEqual(identities(availableWorkInRoom(f.store, "commons", { limit: 50 }).items),
    new Set(["board-native", "task-open"]));
  // The flip's contract: availability flows ONLY through the board. An
  // item whose card is missing (a legacy database the backfill has not
  // reached) is NOT offered through any second source...
  f.store.db.prepare("DELETE FROM work_claims WHERE room_id='commons' AND claim_id IN ('task-open', 'task-done', 'task-idle')").run();
  assert.deepEqual(identities(availableWorkInRoom(f.store, "commons", { limit: 50 }).items),
    new Set(["board-native"]));
  // ...and the backfill restores it, which is why the open-time pass
  // (PR-1) is the flip's precondition.
  f.store.backfillRoomWorkItemClaims("commons");
  assert.deepEqual(identities(availableWorkInRoom(f.store, "commons", { limit: 50 }).items),
    new Set(["board-native", "task-open"]));
});

// ---------------------------------------------------------------------------
// PR-2 (write-path cutover): store.command syncs the board directly.
// The fixture stays in manual-backfill mode, so every card below was
// written by the sync — and after every command the backfill's own diff
// must read converged (sync ≡ backfill by construction).

const boardEvents = (f, claimId) => f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all()
  .map(row => JSON.parse(row.body))
  .filter(event => event.type === "work_claim.updated" && event.data?.workClaim === claimId)
  .map(event => event.data.action);

test("sync: the full lifecycle lands on the board command by command, diff converged at each step", async (t) => {
  const f = fixture(t);
  const signEvidence = makeTestSigner(f.store);
  const converged = () => assert.equal(diffRoomWorkItems(f.store, "commons").converged, true);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "task-live", title: "Live task", definitionOfDone: "Sync it",
    accountableMemberId: "worker", verifierMemberId: "owner", mode: "write", labels: ["live"],
  });
  assert.equal(f.store.workClaims.get("commons", "task-live"), null); // proposed: no card
  f.mutate(f.workerKey, "accept", "work.accepted", "task-live");
  assert.equal(f.store.workClaims.get("commons", "task-live").state, "unclaimed");
  converged();
  f.mutate(f.workerKey, "claim", "claim.acquired", "task-live", {
    repository: "Uuriko/project-room", ref: "main", paths: ["server/**"],
    expiresAt: new Date(Date.now() + 2 * H).toISOString(),
  });
  let card = f.store.workClaims.get("commons", "task-live");
  assert.equal(card.state, "claimed");
  assert.equal(card.owner, "worker");
  assert.deepEqual(boardEvents(f, "task-live"), ["created", "claimed"]);
  converged();
  f.mutate(f.workerKey, "start", "work.started", "task-live");
  assert.equal(f.store.workClaims.get("commons", "task-live").state, "in_progress");
  converged();
  f.mutate(f.workerKey, "block", "work.blocked", "task-live", { reason: "waiting", nextAction: "ping" });
  card = f.store.workClaims.get("commons", "task-live");
  assert.equal(card.state, "blocked");
  assert.equal(card.premiseFlag.reason, "waiting");
  converged();
  f.mutate(f.workerKey, "resolve", "work.blocker_resolved", "task-live", { resolution: "go" });
  assert.equal(f.store.workClaims.get("commons", "task-live").state, "claimed");
  converged();
  f.mutate(f.workerKey, "restart", "work.started", "task-live");
  const text = "Live delivery";
  f.mutate(f.workerKey, "complete", "work.completed", "task-live", {
    summary: text, evidenceVersion: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    producerId: "worker", evidenceUrl: "https://example.com/live", nextAction: "Verify",
    signedEvidence: signEvidence(),
  });
  card = f.store.workClaims.get("commons", "task-live");
  assert.equal(card.state, "done"); // the transition the frozen mirror could never make
  assert.equal(card.attestations[0].note, text);
  converged();
  const receipt = f.item("task-live").receipt;
  f.mutate(f.ownerKey, "verify", "verification.recorded", "task-live", {
    result: "pass", completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion, summary: "ok",
  });
  assert.equal(f.store.workClaims.get("commons", "task-live").reviewedBy, "owner");
  converged();
  assert.ok(boardEvents(f, "task-live").includes("state_changed"));
});

test("sync: release returns the card to unclaimed and renew extends it, with the mirror's event actions", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "task-lease", title: "Lease task", definitionOfDone: "x",
    accountableMemberId: "worker", mode: "write",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "task-lease");
  f.mutate(f.workerKey, "claim", "claim.acquired", "task-lease", {
    repository: "Uuriko/project-room", ref: "main", paths: ["server/**"],
    expiresAt: new Date(Date.now() + 2 * H).toISOString(),
  });
  f.mutate(f.workerKey, "renew", "claim.renewed", "task-lease", { expiresAt: new Date(Date.now() + 5 * H).toISOString() });
  let card = f.store.workClaims.get("commons", "task-lease");
  assert.ok(Date.parse(card.leaseExpiresAt) > Date.now() + 4 * H);
  assert.deepEqual(boardEvents(f, "task-lease"), ["created", "claimed", "renewed"]);
  f.mutate(f.workerKey, "release", "claim.released", "task-lease");
  card = f.store.workClaims.get("commons", "task-lease");
  assert.equal(card.state, "unclaimed");
  assert.equal(card.owner, null);
  assert.deepEqual(card.files, []);
  assert.deepEqual(boardEvents(f, "task-lease"), ["created", "claimed", "renewed", "released"]);
  assert.equal(diffRoomWorkItems(f.store, "commons").converged, true);
});

test("sync: handoff leaves a -next phantom and supersede closes the source, like the mirror did", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "task-hand", title: "Handoff task", definitionOfDone: "x",
    accountableMemberId: "worker", mode: "write",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "task-hand");
  f.mutate(f.workerKey, "claim", "claim.acquired", "task-hand", {
    repository: "Uuriko/project-room", ref: "main", paths: ["server/**"],
    expiresAt: new Date(Date.now() + 2 * H).toISOString(),
  });
  f.mutate(f.workerKey, "start", "work.started", "task-hand");
  f.mutate(f.workerKey, "handoff", "work.handoff_recorded", "task-hand", {
    doneSummary: "Part", evidenceUrl: "https://example.com/e", evidenceVersion: "v1",
    nextAction: "Finish it", limitReason: "time",
  });
  const next = f.store.workClaims.get("commons", "task-hand-next");
  assert.equal(next.title, "Finish it");
  assert.deepEqual(next.dependsOn, ["task-hand"]);
  assert.equal(f.store.workClaims.get("commons", "task-hand").chain[0].kind, "handoff");

  f.send(f.ownerKey, "propose-2", "work.proposed", {
    workItemId: "task-new", title: "Replacement", definitionOfDone: "y",
    accountableMemberId: "worker", mode: "read",
  });
  f.mutate(f.ownerKey, "supersede", "work.superseded", "task-hand", { supersededByWorkItemId: "task-new", reason: "replanned" });
  const source = f.store.workClaims.get("commons", "task-hand");
  assert.equal(source.state, "closed");
  assert.equal(source.supersededBy, "task-new");
  assert.equal(diffRoomWorkItems(f.store, "commons").converged, true);
});

test("sync: the mirror's caps and occupied-successor refusal still roll commands back", async (t) => {
  const f = fixture(t);
  f.store.workClaims.configure("commons", { maxOpenClaims: 2, maxMemberOpenClaims: 1 });
  const propose = (id, n) => f.send(f.ownerKey, `propose-${n}`, "work.proposed", {
    workItemId: id, title: id, definitionOfDone: "x", accountableMemberId: "worker", mode: "write",
  });
  propose("task-cap-a", 1);
  propose("task-cap-b", 2);
  f.mutate(f.workerKey, "accept-a", "work.accepted", "task-cap-a");
  f.mutate(f.workerKey, "accept-b", "work.accepted", "task-cap-b");
  // Two cards exist (cap = 2): the member cap (1) refuses worker's second claim.
  f.mutate(f.workerKey, "claim-a", "claim.acquired", "task-cap-a", {
    repository: "Uuriko/project-room", ref: "main", paths: ["a/**"], expiresAt: new Date(Date.now() + 2 * H).toISOString(),
  });
  assert.throws(
    () => f.mutate(f.workerKey, "claim-b", "claim.acquired", "task-cap-b", {
      repository: "Uuriko/project-room", ref: "main", paths: ["b/**"], expiresAt: new Date(Date.now() + 2 * H).toISOString(),
    }),
    error => error.code === "too_many_open_claims");
  assert.equal(f.item("task-cap-b").claim, null); // the command rolled back, projection included

  // Occupied successor: a live board-native claim sits at the -next id.
  const { createWork, claimWork } = await import("../server/work-claims.mjs");
  const foreign = claimWork(createWork({ id: "task-cap-a-next", title: "Someone else's" }, { now: Date.now(), agentId: "owner" }), "owner", { now: Date.now() });
  f.store.workClaims.set("commons", foreign);
  assert.throws(
    () => f.mutate(f.workerKey, "handoff", "work.handoff_recorded", "task-cap-a", {
      doneSummary: "Part", evidenceUrl: "https://example.com/e", evidenceVersion: "v1", nextAction: "Next", limitReason: "time",
    }),
    error => error.code === "work_claim_conflict");
  assert.ok(!f.item("task-cap-a").handoff); // rolled back (no handoff recorded)
});
