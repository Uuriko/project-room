// RC-2026-09-18-045: claim file-collision detector — open claims whose
// file lists overlap are flagged before work starts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  findClaimCollisions,
  claimsAreCollisionFree,
  ClaimCollisionError,
} from "../server/claim-collisions.mjs";

const claim = (id, files, { lane = "quill", status = "submitted" } = {}) =>
  ({ id, lane, files, status });

test("detects a file claimed by two open claims", () => {
  const collisions = findClaimCollisions([
    claim("RC-2026-09-18-044", ["server/agent-directory.mjs", "docs/X.md"]),
    claim("RC-2026-09-18-045", ["server/agent-directory.mjs"]),
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].file, "server/agent-directory.mjs");
  assert.deepEqual([...collisions[0].claims], ["RC-2026-09-18-044", "RC-2026-09-18-045"]);
  assert.deepEqual([...collisions[0].lanes], ["quill"]);
  assert.ok(Object.isFrozen(collisions) && Object.isFrozen(collisions[0])
    && Object.isFrozen(collisions[0].claims) && Object.isFrozen(collisions[0].lanes));
});

test("reports every shared file, sorted; lanes deduplicated and sorted", () => {
  const collisions = findClaimCollisions([
    claim("RC-1", ["b.mjs", "a.mjs"], { lane: "instinct" }),
    claim("RC-2", ["a.mjs", "c.mjs"], { lane: "grokbot" }),
    claim("RC-3", ["b.mjs"], { lane: "instinct" }),
  ]);
  assert.deepEqual(collisions.map(c => c.file), ["a.mjs", "b.mjs"]);
  assert.deepEqual([...collisions[0].lanes], ["grokbot", "instinct"]);
  assert.deepEqual([...collisions[1].claims], ["RC-1", "RC-3"]);
});

test("closed claims release their files and never collide", () => {
  for (const status of ["done", "withdrawn", "closed", "expired", "released", "rejected"]) {
    const collisions = findClaimCollisions([
      claim("RC-1", ["a.mjs"], { status }),
      claim("RC-2", ["a.mjs"]),
    ]);
    assert.equal(collisions.length, 0, `status ${status} should release files`);
  }
  assert.ok(claimsAreCollisionFree([
    claim("RC-1", ["a.mjs"], { status: "done" }),
    claim("RC-2", ["a.mjs"]),
  ]));
});

test("duplicate entries inside one claim do not self-collide", () => {
  const collisions = findClaimCollisions([
    claim("RC-1", ["a.mjs", "a.mjs", "./a.mjs"]),
  ]);
  assert.equal(collisions.length, 0);
});

test("path normalization catches ./ and // variants of the same file", () => {
  const collisions = findClaimCollisions([
    claim("RC-1", ["./server/x.mjs"]),
    claim("RC-2", ["server//x.mjs"]),
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].file, "server/x.mjs");
});

test("empty input and disjoint claims are collision-free", () => {
  assert.deepEqual(findClaimCollisions([]), []);
  assert.ok(claimsAreCollisionFree([
    claim("RC-1", ["a.mjs"]),
    claim("RC-2", ["b.mjs"]),
  ]));
});

test("malformed inputs throw coded errors", () => {
  assert.throws(() => findClaimCollisions("nope"), ClaimCollisionError);
  assert.throws(() => findClaimCollisions([null]), ClaimCollisionError);
  assert.throws(() => findClaimCollisions([{ id: "", files: [] }]), ClaimCollisionError);
  assert.throws(() => findClaimCollisions([{ id: "RC-1", files: [""] }]), ClaimCollisionError);
  assert.throws(() => findClaimCollisions([{ id: "RC-1", files: [42] }]), ClaimCollisionError);
  assert.throws(() => findClaimCollisions([{ id: "RC-1" }]), ClaimCollisionError);
});
