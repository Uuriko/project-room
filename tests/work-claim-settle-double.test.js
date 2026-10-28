// QA200 mutation probe MUT-15 (settle double-apply), probe A.
//
// settlePullRequest is the only path that moves a claim to a terminal
// state. The terminal-state guard (LIVE_CLAIM_STATES) is what makes the
// second settle of the same pull request impossible: a merged claim sits
// in "done", a closed-released claim in "unclaimed", and neither is live.
//
// Contract: settling an already-settled item returns null — the second
// settle must be terminal (no-op), never a second settlement record.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Observable contract: settlePullRequest(item, ...) returns null when
//    item.state is a terminal state ("done" / "unclaimed").
// 2. Credible regression: the probe's mutation (adding "done"/"unclaimed"
//    to LIVE_CLAIM_STATES) reproduced an accepted second settlement with
//    every existing settle test still green (2026-10-08).
// 3. Existing coverage: nothing asserted double-settle terminality before
//    this file.
// 4. No test-only seam: the real exported function, plain claim-shaped
//    objects.
import test from "node:test";
import assert from "node:assert/strict";
import { settlePullRequest } from "../server/claim-coordination.mjs";

const NOW = Date.UTC(2026, 9, 8, 7, 30, 0);
const URL = "https://github.com/Uuriko/project-room/pull/2031";
const mergedLink = () => Object.freeze({
  url: URL, repo: "Uuriko/project-room", number: 2031,
  outcome: "merged", syncedAt: "2026-10-08T07:00:00.000Z",
});

function liveClaim() {
  return {
    id: "mut15-double-claim",
    state: "claimed",
    owner: "alice",
    files: ["server/claim-coordination.mjs"],
    pullRequest: { url: URL, repo: "Uuriko/project-room", number: 2031 },
    pullRequests: [mergedLink()],
  };
}

test("probe A (merged): a second settle of a done claim returns null, not a new settlement", () => {
  const first = settlePullRequest(liveClaim(), "merged", NOW);
  assert.ok(first, "the first settle applies");
  assert.equal(first.item.state, "done");
  const second = settlePullRequest(first.item, "merged", NOW + 1000);
  assert.equal(second, null, "a done claim is terminal: the second settle must not apply");
});

test("probe A (closed): a second settle of a released claim returns null, not a new settlement", () => {
  const closedItem = { ...liveClaim(), pullRequests: [Object.freeze({ ...mergedLink(), outcome: "closed" })] };
  const first = settlePullRequest(closedItem, "closed", NOW);
  assert.ok(first, "the first settle applies");
  assert.equal(first.item.state, "unclaimed");
  const second = settlePullRequest(first.item, "closed", NOW + 1000);
  assert.equal(second, null, "a released claim is terminal: the second settle must not apply");
});
