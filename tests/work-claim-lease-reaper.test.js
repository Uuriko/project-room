// FIX-13 (WAVE-300): timer reaper for quiet rooms.
// A room with no inbound requests must still get its lapsed leases reaped:
// the claim-lease-reaper background job ticks every 60s and reaps expired
// leases through the same sweep the request and cron paths use, capped at
// 5 reaps per cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";
import {
  JOBS, jobByName, jobEnabled, jobIsDue, MINUTE_MS, REAPER_MAX_RELEASES_PER_TICK,
} from "../server/jobs.mjs";

const ROOM = "reaper-room";
const NOW = Date.UTC(2026, 9, 9, 20, 0, 0);

function quietStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());
  return store;
}

// A claimed item. atMs 2h ago + 1h lease => already lapsed; atMs now =>
// live for another hour.
function seedClaimed(store, id, { atMs = NOW - 2 * 3600 * 1000, leaseHours = 1, owner = "lane-a" } = {}) {
  const item = claimWork(createWork({ id }, { now: atMs, agentId: owner }), owner,
    { now: atMs, leaseHours });
  store.workClaims.set(ROOM, item);
  return store.workClaims.get(ROOM, id);
}

function leaseExpiredEvents(store) {
  return store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence")
    .all(ROOM)
    .map(row => JSON.parse(row.body))
    .filter(event => event.type === "work_claim.updated" && event.data?.action === "lease_expired");
}

function spyWakes(store) {
  const wakes = [];
  const heartbeats = store.agentHeartbeats;
  const original = heartbeats.enqueueWake.bind(heartbeats);
  heartbeats.enqueueWake = wake => { wakes.push(wake); return original(wake); };
  return wakes;
}

function runReaper(store, nowMs = NOW) {
  const job = jobByName("claim-lease-reaper");
  assert.ok(job, "the claim-lease-reaper job is registered");
  return job.run(store, { now: () => nowMs, deadline: nowMs + 5000, env: {} });
}

test("the reaper job is registered: 60s cadence, both runtimes, 5-per-cycle bound", () => {
  const job = jobByName("claim-lease-reaper");
  assert.ok(job, "claim-lease-reaper is in the JOBS registry");
  assert.equal(job.cadenceMs, MINUTE_MS, "the tick is 60s");
  assert.ok(job.runtimes.includes("node") && job.runtimes.includes("worker"),
    "the reaper runs on the node scheduler and the worker alarm");
  assert.equal(REAPER_MAX_RELEASES_PER_TICK, 5, "the playbook bound is 5 reaps per cycle");
  assert.equal(JOBS.filter(item => item.name === "claim-lease-reaper").length, 1,
    "exactly one reaper job is registered");
  assert.equal(jobIsDue(job, null, MINUTE_MS, 0), true, "due every 60s");
  assert.equal(jobIsDue(job, null, MINUTE_MS - 1, 0), false, "not due early");
});

test("a quiet room's expired lease is reaped with no inbound request", async t => {
  const store = quietStore(t);
  seedClaimed(store, "quiet-claim", { owner: "lane-a" });
  const wakes = spyWakes(store);
  // No handleWorkClaims call anywhere: the room is quiet. Only the tick runs.
  const out = await runReaper(store);

  assert.equal(out.released, 1, "one lapsed lease reaped");
  const after = store.workClaims.get(ROOM, "quiet-claim");
  assert.equal(after.state, "unclaimed", "the claim is released");
  assert.equal(after.owner, null, "the owner is cleared");
  assert.equal(after.leaseExpiresAt, null, "the lease is cleared");
  const lastHistory = after.history[after.history.length - 1];
  assert.equal(lastHistory.action, "lease_expired", "history stamps the expiry");

  const events = leaseExpiredEvents(store);
  assert.equal(events.length, 1, "one lease_expired receipt");
  assert.equal(events[0].data.previousOwnerId, "lane-a", "the receipt names the dead owner");

  assert.equal(wakes.length, 1, "the former owner is woken once");
  assert.equal(wakes[0].roomId, ROOM);
  assert.ok(String(wakes[0].messageId).includes("work-claim:quiet-claim:lease_expired:"),
    `wake carries the lease_expired message id (got ${wakes[0].messageId})`);
});

test("the per-cycle bound caps reaps at 5; the next tick takes the rest", async t => {
  const store = quietStore(t);
  for (let i = 0; i < 7; i++) seedClaimed(store, `bound-claim-${i}`, { owner: `lane-${i}` });

  const first = await runReaper(store);
  assert.equal(first.released, 5, "first cycle reaps exactly 5");
  const stillHeld = store.workClaims.list(ROOM).filter(item => item.state !== "unclaimed");
  assert.equal(stillHeld.length, 2, "two lapsed leases wait for the next cycle");

  const second = await runReaper(store, NOW + MINUTE_MS);
  assert.equal(second.released, 2, "second cycle reaps the remainder");
  assert.equal(store.workClaims.list(ROOM).filter(item => item.state !== "unclaimed").length, 0,
    "nothing lapsed is left held");
});

test("a tick with nothing expired is a no-op: no writes, no events, no wakes", async t => {
  const store = quietStore(t);
  seedClaimed(store, "live-claim", { atMs: NOW, owner: "lane-a" });
  const wakes = spyWakes(store);

  const out = await runReaper(store);
  assert.equal(out.released, 0, "nothing reaped");
  const after = store.workClaims.get(ROOM, "live-claim");
  assert.equal(after.state, "claimed", "the live claim is untouched");
  assert.equal(after.owner, "lane-a", "the holder keeps it");
  assert.equal(leaseExpiredEvents(store).length, 0, "no lease_expired receipts");
  assert.equal(wakes.length, 0, "no wakes");
});

test("the job stays disabled while no live claim holds a lease", t => {
  const job = jobByName("claim-lease-reaper");
  assert.ok(job, "the claim-lease-reaper job is registered");

  const empty = quietStore(t);
  assert.equal(jobEnabled(job, {}, empty), false,
    "a room with no claims does not arm the worker alarm");

  seedClaimed(empty, "held-claim", { atMs: NOW, owner: "lane-a" });
  assert.equal(jobEnabled(job, {}, empty), true,
    "a room holding a live lease arms the 60s tick");
});
