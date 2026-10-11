// WAVE-500 G4 lease-reaper probe: the claim-prs cron is the only background
// sweep of expired leases (syncClaimPullRequests -> sweepExpiredClaimLeases),
// but its job gate only wakes for an open pull-request poll or an
// autolink-eligible claim. A dead agent's pure file-lease claim (no PR link,
// no repo) never wakes the tick, so its expiry is discovered lazily on the
// next board read instead of within a minute.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";
import { jobByName, jobEnabled, jobNextDue } from "../server/jobs.mjs";
import { syncClaimPullRequests } from "../server/claim-pr-sync.mjs";

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 11, 4, 50, 0);
const OLD = NOW - 3 * HOUR;

function leaseStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  return store;
}

function lapsedLeaseOnly(store) {
  const item = claimWork(
    createWork({ id: "dead-agent-file" }, { now: OLD, agentId: "alice" }),
    "alice",
    { now: OLD, leaseHours: 1 } // expired two hours ago; no PR link, no repo
  );
  store.workClaims.set("commons", item);
}

const claimPrs = () => jobByName("claim-prs");

test("a lapsed lease-only claim wakes the claim-prs tick", t => {
  const store = leaseStore(t);
  lapsedLeaseOnly(store);
  assert.equal(jobEnabled(claimPrs(), {}, store), true,
    "expired lease must enable the claim-prs job (background reaper)");
  assert.notEqual(jobNextDue(claimPrs(), store, NOW), null,
    "expired lease must give the claim-prs job a due time");
});

test("a live lease-only claim does not wake the tick", t => {
  const store = leaseStore(t);
  const item = claimWork(
    createWork({ id: "live-file" }, { now: NOW, agentId: "alice" }),
    "alice",
    { now: NOW, leaseHours: 6 }
  );
  store.workClaims.set("commons", item);
  assert.equal(jobEnabled(claimPrs(), {}, store), false);
  assert.equal(jobNextDue(claimPrs(), store, NOW), null);
});

test("once the tick runs, the lapsed lease is released without any board read", async t => {
  const store = leaseStore(t);
  lapsedLeaseOnly(store);
  const out = await syncClaimPullRequests(store, { nowMs: NOW, deadline: NOW + 5000 });
  assert.equal(out.checked, 0);
  const after = store.workClaims.get("commons", "dead-agent-file");
  assert.equal(after.state, "unclaimed");
  assert.equal(after.owner, null);
});
