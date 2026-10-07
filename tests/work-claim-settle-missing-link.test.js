// Bug-hunt wave (qa-bughunt-claim-20261006): settlePullRequest must never throw
// on a decoder-producible row shape.
//
// server/work-claim-sqlite.mjs decodes rows by field filtering + defaults —
// nothing enforces the (pullRequest, pullRequests) pair at the codec level,
// so a row CAN carry settled pullRequests links with a null singular
// pullRequest (hand-written row, migration, or a future writer that records
// the plural without the singular). settlePullRequest already computes
// `current = item.pullRequest ?? pullLinks(item).at(-1)` for exactly this
// shape, but the history notes dereference `item.pullRequest.url` directly:
// the tick throws TypeError, and syncClaimPullRequests' single write
// transaction rolls back the ENTIRE batch of settlements for that tick —
// the row stays due, so the tick wedges on the same row every cycle.
//
// Contract: settlement settles (never throws) using the plural fallback link.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Observable contract: settlePullRequest settles merged/closed outcomes on
//    rows whose singular pull link is missing, via the pullRequests fallback.
// 2. Credible regression: any writer/migration producing pullRequests without
//    the singular reintroduces a tick-wedging 500; only this shape triggers it.
// 3. Existing coverage: tests/work-claim-batch-outcome.test.js exercises
//    settlePullRequest with well-formed items only; nothing covers the
//    missing-singular shape.
// 4. No test-only seam: the real exported function, plain row-shaped objects.
import test from "node:test";
import assert from "node:assert/strict";
import { settlePullRequest } from "../server/claim-coordination.mjs";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const URL = "https://github.com/Uuriko/project-room/pull/1600";
const settledLink = outcome => Object.freeze({ url: URL, repo: "Uuriko/project-room", number: 1600, outcome });

for (const outcome of ["merged", "closed"]) {
  test(`settlePullRequest settles (never throws) when the singular pull link is null: ${outcome}`, () => {
    const item = {
      id: "missing-link-claim",
      state: "claimed",
      owner: "alice",
      files: ["server/claim-coordination.mjs"],
      pullRequest: null,
      pullRequests: [settledLink(outcome)],
    };
    const settled = settlePullRequest(item, outcome, NOW);
    assert.ok(settled, "a live claim with all links settled must settle, not return null");
    assert.equal(settled.action, outcome === "merged" ? "pr_merged" : "pr_closed");
    assert.equal(settled.item.pullRequest.url, URL, "the settled record keeps the fallback link's URL");
    assert.ok(
      settled.item.history.some(h => h.action === settled.action && h.note.includes(URL)),
      "the history note names the settled pull URL without throwing"
    );
  });

  test(`settlePullRequest settles (never throws) when the singular pull link is undefined: ${outcome}`, () => {
    const item = {
      id: "missing-link-claim",
      state: "in_progress",
      owner: "alice",
      files: [],
      pullRequests: [settledLink(outcome)],
    };
    const settled = settlePullRequest(item, outcome, NOW);
    assert.ok(settled, "a live claim with all links settled must settle, not return null");
    assert.equal(settled.item.pullRequest.url, URL);
  });
}

test("settlePullRequest still prefers the live singular link when it is set", () => {
  const live = Object.freeze({ url: URL, repo: "Uuriko/project-room", number: 1600 });
  const item = {
    id: "normal-claim",
    state: "claimed",
    owner: "alice",
    files: [],
    pullRequest: live,
    pullRequests: [settledLink("merged")],
  };
  const settled = settlePullRequest(item, "merged", NOW);
  assert.equal(settled.action, "pr_merged");
  assert.equal(settled.item.state, "done");
  assert.equal(settled.item.pullRequest.url, URL);
});
