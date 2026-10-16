// Step 0 characterization for charter B-4 (workItems -> board claims,
// finished; decision B10/D4, redesign council 2026-10-15). Step 0 cuts
// nothing: it pins (a) every live site that references workItems, (b) the
// work-mutating events that never reach the board write-path sync, and
// (c) the field fates of the current mapping — including the live state
// that has NO board-claims home (the council kill-criterion evidence).
// If a future change adds a reader, moves a field, or fixes a divergence,
// this suite fails until the Step 0 record
// (docs/WORKITEMS-BOARD-STEP0.md) is updated with it. The migration does
// not proceed past Step 0 on a stale census.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { WORK_ITEM_BOARD_SYNC_TYPES } from "../server/work-item-board.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

// (a) Reference-site inventory: every file under server/ and src/ whose
// source mentions workItems at all (readers, writers, validators, and
// pass-throughs). Generated 2026-10-15 at the Step 0 base; 55 files.
const WORKITEMS_REFERENCE_SITES = [
  "server/agent-fleet.mjs", "server/agent-identities.mjs", "server/available-work.mjs", "server/claim-scopes.mjs", "server/content-trust.mjs", "server/inbox.mjs", "server/mcp-room-profile.mjs", "server/message-redaction.mjs", "server/messages-store.mjs", "server/needs-me.mjs", "server/notifications.mjs", "server/opportunities.mjs", "server/orient.mjs", "server/owner-attention.mjs", "server/project-offers.mjs", "server/public-read-model.mjs", "server/public-work-reviews.mjs", "server/purge-registry.mjs", "server/recovery.mjs", "server/reminders.mjs", "server/reply-requests.mjs", "server/return-brief.mjs", "server/room-activation-pack.mjs", "server/room-context.mjs", "server/spend-allowance.mjs", "server/store.mjs", "server/text-results.mjs", "server/updates.mjs", "server/usage-summary.mjs", "server/work-context.mjs", "server/work-discussion.mjs", "server/work-help.mjs", "server/work-item-board.mjs", "server/work-wakes.mjs", "server/writer-fence.mjs",
  "src/app.js", "src/board-ui.js", "src/board.js", "src/conversation.js", "src/events.js", "src/growth-emit.js", "src/help-offers.js", "src/human-experience.js", "src/portable-work.js", "src/reminders.js", "src/reply-requests.js", "src/room-layout.js", "src/room-templates.js", "src/work-help.js", "src/work-item-session.js", "src/work-packet.js", "src/work-recipes.js", "src/work-selectors.js", "src/workflow.js",
];

function referenceSites() {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue; }
      if (!/\.(mjs|js)$/.test(entry.name)) continue;
      if (readFileSync(join(dir, entry.name), "utf8").includes("workItems")) found.push(rel);
    }
  };
  const root = new URL("..", import.meta.url).pathname;
  walk(join(root, "server"), "server");
  walk(join(root, "src"), "src");
  return found.sort();
}

test("step0 census: workItems reference-site inventory is pinned (55 files)", () => {
  assert.deepEqual(referenceSites(), WORKITEMS_REFERENCE_SITES);
});

test("step0 census: the board write-path sync covers exactly 12 event types; the unsynced work events are named", () => {
  assert.deepEqual([...WORK_ITEM_BOARD_SYNC_TYPES].sort(), [
    "claim.acquired", "claim.released", "claim.renewed",
    "owner.decision_recorded", "verification.recorded",
    "work.accepted", "work.blocked", "work.blocker_resolved", "work.completed",
    "work.handoff_recorded", "work.started", "work.superseded",
  ]);
  // Work-mutating events the reducer handles that are NOT synced — each
  // one's board fate is a Step 0 finding, not an oversight to silently fix:
  // work.proposed (deliberate: no card until accepted), work.help_updated
  // (helpWanted has no board field), work.public_set (publicTask linkage
  // has no board field), work.halt_cleared (handoff halt state only).
  for (const type of ["work.proposed", "work.help_updated", "work.public_set", "work.halt_cleared"]) {
    assert.equal(WORK_ITEM_BOARD_SYNC_TYPES.has(type), false, `${type} must stay unsynced at Step 0`);
  }
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "workitems-step0-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-worker", type: "member.added", data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] } });
  store.command(ownerKey, "commons", { id: "add-verifier", type: "member.added", data: { memberId: "verifier", displayName: "verifier", kind: "human", permissions: ["verify"] } });
  const workerKey = store.issueAccessKey("commons", "worker");
  const verifierKey = store.issueAccessKey("commons", "verifier");
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const item = id => store.room("commons").state.workItems[id];
  const mutate = (key, id, type, workItemId, data = {}) => send(key, id, type, { workItemId, expectedRevision: item(workItemId).revision, ...data });
  const board = id => store.workClaims.get("commons", id);
  return { store, ownerKey, workerKey, verifierKey, send, item, mutate, board, signEvidence: () => makeTestSigner(store) };
}

test("step0 fates: a maximally populated item's board row drops the named fields and keeps the named survivors", async (t) => {
  const f = fixture(t);
  const signEvidence = f.signEvidence();
  f.send(f.ownerKey, "propose", "work.proposed", {
    workItemId: "fate-1", title: "Fate item", definitionOfDone: "DOD-SENTINEL",
    accountableMemberId: "worker", verifierMemberId: "verifier", humanDecisionMakerId: "owner",
    independentVerificationRequired: true, ownerDecisionRequired: true,
    labels: ["fate", "second-label"], mode: "write",
  });
  f.mutate(f.workerKey, "accept", "work.accepted", "fate-1");
  const expiresAt = new Date(Date.now() + 2 * 3600e3).toISOString();
  f.mutate(f.workerKey, "claim", "claim.acquired", "fate-1", { repository: "Uuriko/project-room", ref: "main", paths: ["server/**"], expiresAt, pullRequests: ["https://github.com/Uuriko/project-room/pull/7"] });
  f.mutate(f.workerKey, "start", "work.started", "fate-1");
  f.mutate(f.workerKey, "handoff", "work.handoff_recorded", "fate-1", { doneSummary: "HANDOFF-DONE-SENTINEL", evidenceUrl: "https://example.com/h", evidenceVersion: "v1", nextAction: "HANDOFF-NEXT-SENTINEL", limitReason: "HANDOFF-LIMIT-SENTINEL" });
  const evidenceVersion = `sha256:${createHash("sha256").update("Delivery text").digest("hex")}`;
  f.mutate(f.workerKey, "complete", "work.completed", "fate-1", { summary: "Delivery text", evidenceVersion, producerId: "worker", evidenceUrl: "https://example.com/delivery", nextAction: "RECEIPT-NEXT-SENTINEL", signedEvidence: signEvidence() });
  const receipt = f.item("fate-1").receipt;
  f.mutate(f.verifierKey, "verify", "verification.recorded", "fate-1", { result: "pass", completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion, summary: "Checks out" });
  assert.equal(f.item("fate-1").verification.independenceConfirmed, true); // computed by the reducer, gates approval semantics

  const row = f.board("fate-1");
  assert.equal(row.state, "done");
  const boardJson = JSON.stringify(row);
  // Survivors: identity, lifecycle, scope, lease, evidence pointers, review.
  assert.equal(row.title, "Fate item");
  assert.equal(row.owner, "worker");
  assert.deepEqual(row.tags, ["fate", "second-label"]);
  assert.deepEqual(row.files, ["server/**"]);
  assert.equal(row.repo, "Uuriko/project-room");
  assert.deepEqual(row.evidenceRefs, ["https://example.com/delivery"]);
  assert.deepEqual(row.blobs, [evidenceVersion]);
  assert.equal(row.reviewPolicy, "independent_principal");
  assert.equal(row.reviews[0].verdict, "approve");
  assert.equal(row.attestations[0].memberId, "worker");
  assert.ok(boardJson.includes("HANDOFF-NEXT-SENTINEL")); // handoff nextAction survives as the chain note
  // Dropped — no board field exists for any of these (Step 0 record §3):
  for (const sentinel of ["DOD-SENTINEL", "RECEIPT-NEXT-SENTINEL", "HANDOFF-DONE-SENTINEL", "HANDOFF-LIMIT-SENTINEL"]) {
    assert.equal(boardJson.includes(sentinel), false, `${sentinel} must not reach the board at Step 0`);
  }
  assert.equal(boardJson.includes(receipt.signedEvidence.signature), false, "the signed evidence object itself has no board home");
  for (const key of ["definitionOfDone", "humanDecisionMakerId", "ownerDecisionRequired", "mode", "verifierMemberId", "accountableMemberId", "receipt", "verification", "handoff", "helpWanted", "publicTask"]) {
    assert.equal(Object.hasOwn(row, key), false, `board row must not carry ${key} at Step 0`);
  }
  // The verification's independenceConfirmed flag — the bit that makes a
  // pass an *independent* approval in the item vocabulary — is not on the
  // board row in any form: the review records only verdict + summary.
  assert.equal(Object.hasOwn(row.reviews[0], "independenceConfirmed"), false);
});

test("step0 fates: accepted-but-unclaimed loses accountable and verifier identity; blocked loses the blocker's next action", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", { workItemId: "fate-2", title: "Accepted", definitionOfDone: "DOD-2", accountableMemberId: "worker", verifierMemberId: "owner", mode: "read" });
  f.mutate(f.workerKey, "accept", "work.accepted", "fate-2");
  const accepted = f.board("fate-2");
  assert.equal(accepted.state, "unclaimed");
  assert.equal(accepted.owner, null); // accountableMemberId has no home while unclaimed
  assert.equal(accepted.reviewPolicy, "distinct_member"); // the verifier survives only as a policy kind, not an identity

  f.send(f.ownerKey, "propose-3", "work.proposed", { workItemId: "fate-3", title: "Blocked", definitionOfDone: "DOD-3", accountableMemberId: "worker", mode: "read" });
  f.mutate(f.workerKey, "accept-3", "work.accepted", "fate-3");
  f.mutate(f.workerKey, "start-3", "work.started", "fate-3");
  f.mutate(f.workerKey, "block-3", "work.blocked", "fate-3", { reason: "BLOCKER-REASON-SENTINEL", nextAction: "BLOCKER-NEXT-SENTINEL" });
  const blocked = f.board("fate-3");
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.premiseFlag.reason, "BLOCKER-REASON-SENTINEL");
  assert.equal(JSON.stringify(blocked).includes("BLOCKER-NEXT-SENTINEL"), false);
});

test("step0 fates: helpWanted and publicTask are live item state the board never learns", async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, "propose", "work.proposed", { workItemId: "fate-4", title: "Help wanted", definitionOfDone: "DOD-4", accountableMemberId: "worker", mode: "read" });
  f.mutate(f.workerKey, "accept", "work.accepted", "fate-4");
  f.send(f.workerKey, "help", "work.help_updated", { workItemId: "fate-4", expectedRevision: f.item("fate-4").revision, expectedHelpRevision: 0, status: "open", scope: "HELP-SCOPE-SENTINEL", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(f.item("fate-4").helpWanted.scope, "HELP-SCOPE-SENTINEL"); // live: the opportunities feed reads this
  assert.equal(JSON.stringify(f.board("fate-4")).includes("HELP-SCOPE-SENTINEL"), false);

  // A proposed item has no board card at all — which is exactly why its
  // publicTask linkage (the public board's task list) can only live here.
  f.send(f.ownerKey, "propose-5", "work.proposed", { workItemId: "fate-5", title: "Public", definitionOfDone: "DOD-5", accountableMemberId: "worker", mode: "read" });
  f.send(f.ownerKey, "publish-5", "work.public_set", { workItemId: "fate-5", enabled: true });
  assert.equal(f.item("fate-5").publicTask.enabled, true);
  assert.equal(f.board("fate-5"), null);
});

test("step0 divergence: rework (completed -> blocked) is live item state the board refuses to follow", async (t) => {
  const f = fixture(t);
  const signEvidence = f.signEvidence();
  f.send(f.ownerKey, "propose", "work.proposed", { workItemId: "fate-6", title: "Reworkable", definitionOfDone: "DOD-6", accountableMemberId: "worker", mode: "read" });
  f.mutate(f.workerKey, "accept", "work.accepted", "fate-6");
  f.mutate(f.workerKey, "start", "work.started", "fate-6");
  f.mutate(f.workerKey, "complete", "work.completed", "fate-6", { summary: "done v1", producerId: "worker", nextAction: "verify", evidenceUrl: "https://example.com/v1", signedEvidence: signEvidence() });
  assert.equal(f.item("fate-6").state, "completed");
  assert.equal(f.board("fate-6").state, "done");
  // The item vocabulary allows rework out of completed (the reducer
  // retires the approval and re-blocks); the board vocabulary makes done
  // terminal, the backfill planner flags the row diverged, and the sync
  // leaves it alone. The two stores disagree, today, on live state.
  f.mutate(f.workerKey, "rework", "work.blocked", "fate-6", { reason: "rework needed", nextAction: "redo" });
  assert.equal(f.item("fate-6").state, "blocked");
  assert.equal(f.board("fate-6").state, "done");
});
