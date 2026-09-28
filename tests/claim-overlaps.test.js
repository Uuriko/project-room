// tests/claim-overlaps.test.js — Work Item claims record path overlaps.
// Contract guarded: a claim on paths that another active claim in the same
// repository already holds still succeeds (warn, never block) and records the
// other work item, its holder and the shared paths. Directory claims overlap
// the files inside them. Other repositories, released and expired claims do
// not count. Paths use the claim-scope grammar (file, folder/**, **).
// Replay gives the same result.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES as T, applyEvent, replay, claimOverlaps } from "../src/events.js";
import { seedEvents } from "../src/seed.js";

const at = "2026-09-05T10:00:00.000Z";
const fixed = (id, type, actorId, data) => ({ id, idempotencyKey: `key-${id}`, roomId: "room-project-room-v0", type, actorId, at, causationId: null, data });
const work = (id, type, actorId, workItemId, expectedRevision, extra = {}) => fixed(id, type, actorId, { workItemId, expectedRevision, ...extra });

function writeWork(state, workItemId, accountable) {
  state = applyEvent(state, fixed(`${workItemId}-p`, T.WORK_PROPOSED, "potter", {
    workItemId, title: `Work ${workItemId}`, definitionOfDone: "Evidence returned",
    accountableMemberId: accountable, verifierMemberId: "instinct", independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: "potter", mode: "write"
  }));
  return applyEvent(state, work(`${workItemId}-a`, T.WORK_ACCEPTED, accountable, workItemId, 0));
}
const claim = (state, workItemId, actor, paths, repository = "Acme/Demo", expiresAt = "2026-09-06T10:00:00.000Z") =>
  applyEvent(state, work(`${workItemId}-c`, T.CLAIM_ACQUIRED, actor, workItemId, state.workItems[workItemId].revision, { repository, ref: `x/${workItemId}`, paths, expiresAt }));

function twoAgents() {
  let state = replay(seedEvents);
  state = applyEvent(state, fixed("add-claude", T.MEMBER_ADDED, "potter", { memberId: "claude", displayName: "Claude", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"] }));
  state = writeWork(state, "w-login", "codex");
  state = writeWork(state, "w-start", "claude");
  return state;
}

test("an overlapping claim succeeds and records who else holds the paths", () => {
  let state = claim(twoAgents(), "w-login", "codex", ["src/app.js", "server/**"]);
  assert.equal(state.workItems["w-login"].claim.overlaps, undefined, "first claim has no overlaps");
  state = claim(state, "w-start", "claude", ["./src/app.js", "server/store.mjs", "deploy/room-entry.mjs"], "acme/demo");
  assert.equal(state.workItems["w-start"].claim.status, "active", "warn, never block");
  assert.deepEqual(state.workItems["w-start"].claim.overlaps, [{ workItemId: "w-login", holderId: "codex", paths: ["src/app.js", "server/**"] }]);
});

test("other repositories and released claims do not overlap", () => {
  let state = claim(twoAgents(), "w-login", "codex", ["src/app.js"]);
  state = applyEvent(state, work("w-login-r", T.CLAIM_RELEASED, "codex", "w-login", state.workItems["w-login"].revision));
  state = claim(state, "w-start", "claude", ["src/app.js"]);
  assert.equal(state.workItems["w-start"].claim.overlaps, undefined);
  assert.deepEqual(claimOverlaps(state, "x", "Other/repo", ["src/app.js"], at), []);
});

test("overlaps are deterministic on replay", () => {
  const run = () => claim(claim(twoAgents(), "w-login", "codex", ["docs/**"]), "w-start", "claude", ["docs/GOAL.md"]);
  const first = run().workItems["w-start"].claim, second = run().workItems["w-start"].claim;
  assert.deepEqual(first.overlaps, [{ workItemId: "w-login", holderId: "codex", paths: ["docs/**"] }]);
  assert.deepEqual(second, first);
});
