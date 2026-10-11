// WAVE-500 G4 (wave500-g4-claims-overlap-exact): exact-path overlap detection
// probe. Claim A declares ["server/store.mjs"]; does claim B's near-miss
// spelling still get flagged as overlapping?
//
// Detector 1: server/claim-collisions.mjs — findClaimCollisions (pure,
// used by the room's pre-work collision flagging).
// Detector 2: server/claim-scopes.mjs — conflictingClaim (live admission
// policy for work-claim scopes).
//
// A variant that lets two active claims hold the same file undetected is a
// bug. Variants that already normalize, or that the admission policy
// fail-closes on (throws instead of waving through), are regression guards.
import test from "node:test";
import assert from "node:assert/strict";
import {
  findClaimCollisions,
  claimsAreCollisionFree,
} from "../server/claim-collisions.mjs";
import { conflictingClaim, ClaimScopeError } from "../server/claim-scopes.mjs";

const fileClaim = (id, files, { lane = "g4", status = "submitted" } = {}) =>
  ({ id, lane, files, status });

// ---------- findClaimCollisions probes ----------

test("exact identical paths collide", () => {
  const collisions = findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["server/store.mjs"]),
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].file, "server/store.mjs");
  assert.deepEqual([...collisions[0].claims], ["g4-a", "g4-b"]);
});

test("probe (a): leading ./ does not dodge detection", () => {
  assert.equal(findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["./server/store.mjs"]),
  ]).length, 1);
});

test("probe (b): double slashes do not dodge detection", () => {
  assert.equal(findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["server//store.mjs"]),
  ]).length, 1);
});

test("probe (d): trailing whitespace does not dodge detection", () => {
  assert.equal(findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["server/store.mjs "]),
  ]).length, 1);
});

test("probe (e): a dot-dot spelling resolving to the same file collides", () => {
  const collisions = findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["server/sub/../store.mjs"]),
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].file, "server/store.mjs");
});

test("probe (c): case-only variant is NOT flagged by default (git semantics are case-sensitive)", () => {
  assert.equal(findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["SERVER/store.mjs"]),
  ]).length, 0);
  assert.ok(claimsAreCollisionFree([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["SERVER/store.mjs"]),
  ]));
});

test("probe (c): caseInsensitive mode flags a case-only variant as the same file", () => {
  const claims = [
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["SERVER/store.mjs"]),
  ];
  const collisions = findClaimCollisions(claims, { caseInsensitive: true });
  assert.equal(collisions.length, 1, "SERVER/store.mjs must collide with server/store.mjs when the FS is case-insensitive");
  assert.equal(collisions[0].file, "server/store.mjs");
  assert.deepEqual([...collisions[0].claims], ["g4-a", "g4-b"]);
});

test("caseInsensitive mode does not invent collisions between truly different files", () => {
  assert.ok(claimsAreCollisionFree([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["server/other.mjs"]),
  ], { caseInsensitive: true }));
  assert.equal(findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs"]),
    fileClaim("g4-b", ["server/store.mjs"]),
  ], { caseInsensitive: true }).length, 1, "exact duplicates still collide in caseInsensitive mode");
});

test("caseInsensitive dedups a within-claim case-variant so it does not self-collide", () => {
  assert.equal(findClaimCollisions([
    fileClaim("g4-a", ["server/store.mjs", "SERVER/store.mjs"]),
  ], { caseInsensitive: true }).length, 0);
});

// ---------- conflictingClaim (live admission) probes ----------

const nowMs = Date.now();
const held = (id, paths) => ({
  id,
  claim: {
    repository: "test/repo", ref: "draft", paths,
    status: "active", expiresAt: new Date(nowMs + 60000).toISOString(),
  },
});
const candidate = (id, paths) => ({
  id, claim: { repository: "test/repo", ref: "draft", paths },
});

test("admission: exact duplicate path is flagged as conflicting", () => {
  const hit = conflictingClaim({ "w-1": held("w-1", ["server/store.mjs"]) }, candidate("w-2", ["server/store.mjs"]), nowMs);
  assert.equal(hit?.id, "w-1");
});

test("admission probe (a): leading ./ is stripped and still conflicts", () => {
  const hit = conflictingClaim({ "w-1": held("w-1", ["server/store.mjs"]) }, candidate("w-2", ["./server/store.mjs"]), nowMs);
  assert.equal(hit?.id, "w-1");
});

test("admission probe (b): double slash is rejected fail-closed, not waved through", () => {
  assert.throws(
    () => conflictingClaim({ "w-1": held("w-1", ["server/store.mjs"]) }, candidate("w-2", ["server//store.mjs"]), nowMs),
    ClaimScopeError,
    "a malformed scope must throw instead of silently missing the conflict",
  );
});

test("admission probe (d): trailing whitespace is rejected fail-closed", () => {
  assert.throws(
    () => conflictingClaim({ "w-1": held("w-1", ["server/store.mjs"]) }, candidate("w-2", ["server/store.mjs "]), nowMs),
    ClaimScopeError,
  );
});

test("admission probe (c): case-only variant is not flagged by default", () => {
  const hit = conflictingClaim({ "w-1": held("w-1", ["server/store.mjs"]) }, candidate("w-2", ["SERVER/store.mjs"]), nowMs);
  assert.equal(hit, null);
});

test("admission probe (c): caseInsensitive mode flags the case-only variant", () => {
  const hit = conflictingClaim(
    { "w-1": held("w-1", ["server/store.mjs"]) },
    candidate("w-2", ["SERVER/store.mjs"]),
    nowMs,
    { caseInsensitive: true },
  );
  assert.equal(hit?.id, "w-1", "SERVER/store.mjs must conflict with server/store.mjs on a case-insensitive FS");
});
