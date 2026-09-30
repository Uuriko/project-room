// receipts-snapshot merge verification (H-5 regression).
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
// 1. Contract: a receipt SHA "verifies" only when the commit is an ancestor
//    of upstream main. Existence in the repo is not enough — a commit on an
//    unmerged branch is fetchable via commits/{sha} but proves no merge, and
//    the old code marked it "verified".
// 2. Credible regression: reverting verifyMergeSha to the old existence
//    check (commits/{sha} -> 200 means verified) re-marks unmerged-branch
//    commits as verified; the "ahead"/"diverged" cases below fail.
// 3. No existing coverage: scripts/receipts-snapshot.mjs had no test file;
//    the row-classification path was only exercised by live runs.
// 4. No new production seams: `api` ({ commitSha, compareStatus }) is the
//    script's own GitHub boundary, injected so tests never touch the
//    network. The stub below is strict: unknown methods throw.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyMergeSha } from "../scripts/receipts-snapshot.mjs";

const FULL = "a".repeat(40);

// Strict stub of the script's GitHub boundary. `exists` controls the
// commits/{sha} answer; `status` controls the compare/main...{sha} answer.
function stubApi({ exists = true, status = "behind" } = {}) {
  return {
    commitSha: async sha => {
      assert.match(sha, /^[0-9a-f]{7,40}$/i, "commitSha receives the candidate SHA");
      return exists ? FULL : null;
    },
    compareStatus: async full => {
      assert.equal(full, FULL, "compare runs against the resolved full SHA");
      return status;
    },
  };
}

test("verifyMergeSha verifies a SHA that is behind main (merged)", async () => {
  assert.equal(await verifyMergeSha("abc1234", stubApi({ status: "behind" })), FULL);
});

test("verifyMergeSha verifies a SHA identical to main", async () => {
  assert.equal(await verifyMergeSha("abc1234", stubApi({ status: "identical" })), FULL);
});

test("verifyMergeSha rejects a fetchable SHA that is ahead of main (unmerged branch)", async () => {
  // The H-5 regression: the old existence check marked this "verified".
  assert.equal(await verifyMergeSha("abc1234", stubApi({ status: "ahead" })), null);
});

test("verifyMergeSha rejects a diverged SHA", async () => {
  assert.equal(await verifyMergeSha("abc1234", stubApi({ status: "diverged" })), null);
});

test("verifyMergeSha fails closed when the SHA does not exist upstream", async () => {
  assert.equal(await verifyMergeSha("abc1234", stubApi({ exists: false })), null);
});

test("verifyMergeSha fails closed when the compare call is unavailable", async () => {
  assert.equal(await verifyMergeSha("abc1234", stubApi({ status: null })), null);
});

test("verifyMergeSha fails closed when the API throws", async () => {
  const throwing = {
    commitSha: async () => { throw new Error("boom"); },
    compareStatus: async () => { throw new Error("boom"); },
  };
  assert.equal(await verifyMergeSha("abc1234", throwing), null);
});

test("verifyMergeSha rejects malformed candidate SHAs without calling the API", async () => {
  let called = 0;
  const counting = {
    commitSha: async () => { called++; return FULL; },
    compareStatus: async () => { called++; return "behind"; },
  };
  for (const bad of ["", "xyz", "abc", "g".repeat(40), "abc1234\nrm -rf"]) {
    assert.equal(await verifyMergeSha(bad, counting), null, `must reject: ${JSON.stringify(bad)}`);
  }
  assert.equal(called, 0, "no network for malformed input");
});
