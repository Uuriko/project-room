// L04-C4: closeWhenLive must not move a land/deploy claim to done from any
// non-terminal state on a bare live-revision match. The live close is the
// reconciliation of a claim whose work is verifiably finished: the claim is
// held (claimed / in_progress / blocked / delivered, owner non-null), its
// lease has not lapsed, every linked pull is settled with at least one
// merged (the poller/webhook-recorded outcome, mirroring settlePullRequest),
// and the claim's revision or CI head is the live revision. Anything else
// stays open — in particular an unclaimed claim and a mid-lifecycle claim
// with no merged pull, the two shapes the audit reproduced from GET routes.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, closeWhenLive } from "../server/work-claims.mjs";
import { recordPullOutcome } from "../server/claim-coordination.mjs";

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const HOUR = 3600_000;
const REV = "rev-live";
const PR = "https://github.com/Uuriko/project-room/pull/123";

const held = (id, over = {}, at = NOW) => claimWork(
  createWork({ id, kind: "land", revision: REV, pullRequest: PR, ...over }, { now: at, agentId: "creator" }),
  "worker", { now: at, leaseHours: 6 });

test("an unclaimed deploy claim at the live revision does not close", () => {
  const item = createWork({ id: "unclaimed", kind: "deploy", revision: REV }, { now: NOW, agentId: "creator" });
  assert.equal(closeWhenLive(item, REV, NOW), null);
  assert.equal(item.state, "unclaimed");
});

test("a mid-lifecycle land claim with no merged pull does not close", () => {
  let item = claimWork(createWork({ id: "mid", kind: "land", revision: REV }, { now: NOW, agentId: "creator" }),
    "worker", { now: NOW, leaseHours: 6 });
  item = updateWork(item, "worker", { state: "in_progress", now: NOW });
  assert.equal(closeWhenLive(item, REV, NOW), null);
  assert.equal(item.state, "in_progress");
});

test("a held land claim whose pull is open or closed-unmerged does not close", () => {
  const open = held("open-pr");
  assert.equal(closeWhenLive(open, REV, NOW), null);
  const closed = recordPullOutcome(held("closed-pr"), PR, "closed", NOW);
  assert.equal(closeWhenLive(closed, REV, NOW), null);
});

test("a held land claim with a lapsed lease does not close even when its pull merged", () => {
  let lapsed = claimWork(createWork({ id: "lapsed-1h", kind: "land", revision: REV, pullRequest: PR },
    { now: NOW - 3 * HOUR, agentId: "creator" }), "worker", { now: NOW - 3 * HOUR, leaseHours: 1 });
  lapsed = recordPullOutcome(lapsed, PR, "merged", NOW - 3 * HOUR);
  assert.equal(closeWhenLive(lapsed, REV, NOW), null);
  // Control: the same shape on a live 6h lease does close.
  let live = claimWork(createWork({ id: "live-lease", kind: "land", revision: REV, pullRequest: PR },
    { now: NOW - 3 * HOUR, agentId: "creator" }), "worker", { now: NOW - 3 * HOUR, leaseHours: 6 });
  live = recordPullOutcome(live, PR, "merged", NOW - 3 * HOUR);
  assert.equal(closeWhenLive(live, REV, NOW)?.state, "done");
});

test("the preserved path: held claim, pull merged, revision live — closes to done", () => {
  const merged = recordPullOutcome(held("merged"), PR, "merged", NOW);
  const closed = closeWhenLive(merged, REV, NOW);
  assert.equal(closed.state, "done");
  assert.equal(closed.deliveryMode, "production");
  assert.equal(closed.history.at(-1).action, "state:done");
});

test("a delivered claim with a merged pull and live revision also closes", () => {
  let item = held("delivered");
  item = updateWork(item, "worker", { state: "in_progress", now: NOW });
  item = updateWork(item, "worker", { state: "delivered", now: NOW,
    delivery: { artifact: { kind: "text", ref: "room://artifacts/1", sha256: "a".repeat(64) },
      checks: [{ name: "unit", result: "pass" }], criteria: [] } });
  item = recordPullOutcome(item, PR, "merged", NOW);
  assert.equal(closeWhenLive(item, REV, NOW)?.state, "done");
});

test("non-land/deploy kinds and revision mismatches never close", () => {
  const work = recordPullOutcome(held("plain", { kind: "work" }), PR, "merged", NOW);
  assert.equal(closeWhenLive(work, REV, NOW), null);
  const merged = recordPullOutcome(held("other-rev"), PR, "merged", NOW);
  assert.equal(closeWhenLive(merged, "some-other-revision", NOW), null);
  assert.equal(closeWhenLive(merged, "", NOW), null);
});
