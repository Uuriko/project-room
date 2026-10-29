// #3612 (accountability R-1/R-9): the shared provenance stamp —
// server-derived facts vs caller-reported claims.
//
// The semantics under test are the design rule itself: sessionInstanceId
// and authorizingPrincipalId are facts the server derives at write time;
// claimedModelVersion / claimedHarnessVersion / claimedEnvironment are
// the acting runtime's self-report, pinned under claimed* names. A
// caller must never be able to mint a fact, and an absent claim must
// read as null ("not reported"), never as a guessed default.
import test from "node:test";
import assert from "node:assert/strict";
import { buildProvenance, claimedProvenanceFromInput, claimedProvenanceOf,
  provenanceOf, sessionInstanceIdFor } from "../server/records-provenance.mjs";

test("sessionInstanceIdFor is deterministic over the claim round and changes with it", () => {
  const a = sessionInstanceIdFor("public-work", ["ns", "task-1", 1, "ai_worker"]);
  assert.equal(a, sessionInstanceIdFor("public-work", ["ns", "task-1", 1, "ai_worker"]));
  assert.match(a, /^sess_[0-9a-f]{24}$/);
  // A new generation (a new claim round) or a different actor is a
  // different instance; a different surface kind is a different stamp.
  assert.notEqual(a, sessionInstanceIdFor("public-work", ["ns", "task-1", 2, "ai_worker"]));
  assert.notEqual(a, sessionInstanceIdFor("public-work", ["ns", "task-1", 1, "ai_other"]));
  assert.notEqual(a, sessionInstanceIdFor("bounty-submission", ["ns", "task-1", 1, "ai_worker"]));
});

test("claimedProvenanceOf maps wire spellings to claimed* names and nulls the unreported", () => {
  assert.deepEqual(claimedProvenanceOf(null),
    { claimedModelVersion: null, claimedHarnessVersion: null, claimedEnvironment: null });
  assert.deepEqual(claimedProvenanceOf({ modelVersion: "model-x/1", harnessVersion: "harness/2", environment: "node-24" }),
    { claimedModelVersion: "model-x/1", claimedHarnessVersion: "harness/2", claimedEnvironment: "node-24" });
  assert.deepEqual(claimedProvenanceFromInput({ claimedModelVersion: "model-y/3" }),
    { claimedModelVersion: "model-y/3", claimedHarnessVersion: null, claimedEnvironment: null });
});

test("claimed values fail closed: over-long, control characters, non-strings", () => {
  assert.throws(() => claimedProvenanceOf({ modelVersion: "x".repeat(201) }), /claimedModelVersion/);
  assert.throws(() => claimedProvenanceOf({ harnessVersion: "bad\u0007value" }), /claimedHarnessVersion/);
  assert.throws(() => claimedProvenanceOf({ environment: 42 }), /claimedEnvironment/);
});

test("buildProvenance carries facts and claims distinctly, frozen", () => {
  const stamp = buildProvenance({
    sessionInstanceId: sessionInstanceIdFor("board-claim", ["c1", "worker", "2026-01-01T00:00:00.000Z", ""]),
    authorizingPrincipalId: "owner",
    claimed: claimedProvenanceOf({ modelVersion: "model-x/1" }),
  });
  assert.equal(stamp.authorizingPrincipalId, "owner");
  assert.equal(stamp.claimedModelVersion, "model-x/1");
  assert.equal(stamp.claimedHarnessVersion, null);
  assert.ok(Object.isFrozen(stamp));
  // A caller-chosen "session id" is not a fact: buildProvenance refuses
  // anything sessionInstanceIdFor did not derive.
  assert.throws(() => buildProvenance({ sessionInstanceId: "my-laptop" }), /sessionInstanceIdFor/);
});

test("provenanceOf round-trips a stamp and rejects malformed ones; legacy null stays null", () => {
  const stamp = buildProvenance({
    sessionInstanceId: sessionInstanceIdFor("bounty-submission", ["B-1", "lane", "abc"]),
    authorizingPrincipalId: "id:agent/poster",
    claimed: claimedProvenanceOf({ environment: "node-24" }),
  });
  assert.deepEqual(provenanceOf(JSON.parse(JSON.stringify(stamp))), stamp);
  assert.equal(provenanceOf(null), null);
  assert.equal(provenanceOf(undefined), null);
  assert.throws(() => provenanceOf({ sessionInstanceId: "forged", authorizingPrincipalId: null }), /sess_/);
  assert.throws(() => provenanceOf("stamp"), /object/);
});

test("falsifier check: no stamp can be built from caller fields alone", () => {
  // claimedProvenanceOf reads only the three claimed fields — a caller
  // object smuggling fact-shaped keys cannot reach the fact slots.
  const claims = claimedProvenanceOf({ modelVersion: "m/1", sessionInstanceId: "sess_forged", authorizingPrincipalId: "mallory" });
  assert.deepEqual(Object.keys(claims).sort(), ["claimedEnvironment", "claimedHarnessVersion", "claimedModelVersion"]);
});
