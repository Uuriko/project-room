// Board cleanup 2026-10-09: muse-room hit the 200 open-claim cap while only
// ~13 claims were live; the rest was an idle unclaimed backlog. These tests
// pin the fix: the cap defaults to 1000 and counts live items only, dormant
// unclaimed items (no activity for STALE_UNCLAIMED_DAYS) stop counting, and
// the cron's stale sweep retires them in bounded batches.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { staleSweepDueAt, sweepStaleUnclaimedClaims, syncClaimPullRequests, STALE_SWEEP_INTERVAL_MS } from "../server/claim-pr-sync.mjs";
import { jobByName, jobEnabled, jobIsDue, jobNextDue } from "../server/jobs.mjs";
import {
  DEFAULT_MAX_OPEN_CLAIMS, STALE_UNCLAIMED_DAYS, STALE_SWEEP_BATCH, closeStaleUnclaimed, countsTowardOpenCap,
  createWork, claimWork, isDormantClaim, openClaimCount,
} from "../server/work-claims.mjs";

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const OLD = NOW - (STALE_UNCLAIMED_DAYS + 1) * DAY;

async function roomStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: { member: { id: "owner", kind: "human", permissions: ["manage_claims"] } },
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
  });
  return { store, call };
}

test("the default room cap is 1000", () => {
  assert.equal(DEFAULT_MAX_OPEN_CLAIMS, 1000);
});

test("dormancy: only unclaimed items idle past the threshold, never unknown age or held work", () => {
  const old = createWork({ id: "old" }, { now: OLD, agentId: "alice" });
  const fresh = createWork({ id: "fresh" }, { now: NOW - DAY, agentId: "alice" });
  const held = claimWork(createWork({ id: "held" }, { now: OLD, agentId: "alice" }), "alice", { now: OLD, leaseHours: null });
  const unknown = { id: "unknown", state: "unclaimed", owner: null, history: [] };
  assert.equal(isDormantClaim(old, NOW), true);
  assert.equal(isDormantClaim(fresh, NOW), false);
  assert.equal(isDormantClaim(held, NOW), false);
  assert.equal(isDormantClaim(unknown, NOW), false);
  assert.equal(countsTowardOpenCap(old, NOW), false);
  assert.equal(countsTowardOpenCap({ ...fresh, state: "done" }, NOW), false);
  assert.equal(openClaimCount([old, fresh, held, unknown], NOW), 3);
});

test("closeStaleUnclaimed retires oldest first, bounded, with a stale_sweep reason", () => {
  const items = Array.from({ length: STALE_SWEEP_BATCH + 5 }, (_, index) =>
    createWork({ id: `s-${String(index).padStart(2, "0")}` }, { now: OLD - index * 1000, agentId: "alice" }));
  const pairs = closeStaleUnclaimed(items, NOW);
  assert.equal(pairs.length, STALE_SWEEP_BATCH);
  assert.equal(pairs[0][0].id, `s-${STALE_SWEEP_BATCH + 4}`, "oldest first");
  for (const [, closed] of pairs) {
    assert.equal(closed.state, "closed");
    const last = closed.history[closed.history.length - 1];
    assert.equal(last.action, "closed");
    assert.match(last.note, /^stale_sweep/);
  }
});

test("a create succeeds past the old count when the backlog is dormant", async t => {
  const { store, call } = await roomStore(t);
  store.workClaims.configure("commons", { maxOpenClaims: 2 });
  for (const id of ["d1", "d2", "d3"]) store.workClaims.set("commons", createWork({ id }, { now: Date.now() - (STALE_UNCLAIMED_DAYS + 1) * DAY, agentId: "owner" }));
  assert.equal((await call("create", null, { id: "live-1" })).status, 201);
  assert.equal((await call("create", null, { id: "live-2" })).status, 201);
  const over = await call("create", null, { id: "live-3" }).catch(error => ({ status: error.status, value: { error: { code: error.code } } }));
  assert.equal(over.status, 409);
  assert.equal(over.value.error.code, "work_board_full");
});

test("the stale sweep is off by default: dormant items stay open and the owner can turn it on", async t => {
  const { store, call } = await roomStore(t);
  store.workClaims.set("commons", createWork({ id: "dormant" }, { now: OLD, agentId: "alice" }));
  assert.equal(store.workClaims.configFor("commons").staleSweep, false);
  assert.equal(sweepStaleUnclaimedClaims(store, NOW, { force: true }), 0);
  assert.equal(store.workClaims.get("commons", "dormant").state, "unclaimed");
  const bad = await call("config", null, { staleSweep: "yes" }).catch(error => ({ status: error.status }));
  assert.equal(bad.status, 422);
  const saved = await call("config", null, { staleSweep: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.staleSweep, true);
  assert.equal(saved.value.maxOpenClaims, DEFAULT_MAX_OPEN_CLAIMS, "turning the sweep on leaves the caps alone");
  assert.equal(sweepStaleUnclaimedClaims(store, NOW, { force: true }), 1);
  assert.equal(store.workClaims.get("commons", "dormant").state, "closed");
});

test("the cron tick sweeps dormant unclaimed items, emits closed events, and throttles", async t => {
  const { store } = await roomStore(t);
  store.workClaims.configure("commons", { staleSweep: true });
  store.workClaims.set("commons", createWork({ id: "dormant" }, { now: OLD, agentId: "alice" }));
  store.workClaims.set("commons", createWork({ id: "recent" }, { now: NOW - DAY, agentId: "alice" }));
  store.workClaims.set("commons", claimWork(createWork({ id: "held" }, { now: OLD, agentId: "alice" }), "alice", { now: OLD, leaseHours: null }));
  const fetchImpl = async () => { throw new Error("no GitHub call expected"); };
  await syncClaimPullRequests(store, { fetchImpl, token: null, nowMs: NOW });
  assert.equal(store.workClaims.get("commons", "dormant").state, "closed");
  assert.equal(store.workClaims.get("commons", "recent").state, "unclaimed");
  assert.equal(store.workClaims.get("commons", "held").state, "claimed");
  const events = store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all("commons")
    .map(row => JSON.parse(row.body)).filter(event => event.type === "work_claim.updated");
  const closedEvent = events.find(event => event.data?.workClaimId === "dormant" || event.data?.id === "dormant" || JSON.stringify(event).includes("\"dormant\""));
  assert.ok(closedEvent, "the sweep emits a room event for the retired item");
  assert.match(JSON.stringify(closedEvent), /"closed"/);
  const stamp = store.workClaims.get("commons", "dormant").history.at(-1);
  assert.equal(stamp.agentId, "system");
  assert.match(stamp.note, /^stale_sweep/);

  store.workClaims.set("commons", createWork({ id: "dormant-2" }, { now: OLD, agentId: "alice" }));
  assert.equal(sweepStaleUnclaimedClaims(store, NOW + 1000), 0, "throttled inside the interval");
  assert.equal(sweepStaleUnclaimedClaims(store, NOW + STALE_SWEEP_INTERVAL_MS), 1);
  assert.equal(store.workClaims.get("commons", "dormant-2").state, "closed");
});

// #3739: the sweep's only caller is the claim-prs tick, and that job used to
// wake only while a pull request was waiting — in a store with no PR-linked
// claims the sweep was unreachable however old unclaimed items got. The job
// now carries a due probe for the sweep itself; these tests pin the probe
// and the scheduler gate.
test("staleSweepDueAt: null until an opted-in room holds an unpinned unclaimed item", async t => {
  const { store } = await roomStore(t);
  store.workClaims.set("commons", createWork({ id: "dormant" }, { now: OLD, agentId: "alice" }));
  assert.equal(staleSweepDueAt(store, NOW), null, "no opt-in, no due time");
  store.workClaims.configure("commons", { staleSweep: true });
  assert.equal(staleSweepDueAt(store, NOW), OLD + STALE_UNCLAIMED_DAYS * DAY,
    "due at the oldest candidate's dormancy instant");
});

test("staleSweepDueAt: a fresh item schedules the wake at its dormancy instant", async t => {
  const { store } = await roomStore(t);
  store.workClaims.configure("commons", { staleSweep: true });
  store.workClaims.set("commons", createWork({ id: "fresh" }, { now: NOW - DAY, agentId: "alice" }));
  assert.equal(staleSweepDueAt(store, NOW), NOW - DAY + STALE_UNCLAIMED_DAYS * DAY);
});

test("staleSweepDueAt: activity is claimUpdatedAt — a fresher history stamp wins over updatedAt", async t => {
  const { store } = await roomStore(t);
  store.workClaims.configure("commons", { staleSweep: true });
  const created = createWork({ id: "touched" }, { now: OLD, agentId: "alice" });
  const touched = { ...created, history: [...created.history, { action: "note", agentId: "alice", at: new Date(NOW - DAY).toISOString() }] };
  store.workClaims.set("commons", touched);
  assert.equal(isDormantClaim(store.workClaims.get("commons", "touched"), NOW), false);
  assert.equal(staleSweepDueAt(store, NOW), NOW - DAY + STALE_UNCLAIMED_DAYS * DAY);
});

test("staleSweepDueAt: pinned items and unknown-age items never schedule a wake", async t => {
  const { store } = await roomStore(t);
  store.workClaims.configure("commons", { staleSweep: true });
  store.workClaims.set("commons", createWork({ id: "pinned", tags: ["Never-Sweep"] }, { now: OLD, agentId: "alice" }));
  const unknown = { ...createWork({ id: "unknown" }, { now: OLD, agentId: "alice" }), updatedAt: null, history: [] };
  store.workClaims.set("commons", unknown);
  assert.equal(staleSweepDueAt(store, NOW), null);
});

test("staleSweepDueAt: a sweep pass inside the interval defers the next wake to the interval", async t => {
  const { store } = await roomStore(t);
  store.workClaims.set("commons", createWork({ id: "dormant" }, { now: OLD, agentId: "alice" }));
  assert.equal(sweepStaleUnclaimedClaims(store, NOW, { force: true }), 0, "not opted in yet: nothing closes");
  store.workClaims.configure("commons", { staleSweep: true });
  assert.equal(staleSweepDueAt(store, NOW), NOW + STALE_SWEEP_INTERVAL_MS,
    "dormancy is already past, but the sweep's own cadence is the next wake");
});

test("claim-prs stays disabled when only an opted-out room has dormant items", async t => {
  const { store } = await roomStore(t);
  store.workClaims.set("commons", createWork({ id: "dormant" }, { now: OLD, agentId: "alice" }));
  const job = jobByName("claim-prs");
  assert.equal(jobEnabled(job, {}, store), false);
  assert.equal(jobIsDue(job, store, NOW, undefined), false);
});

test("claim-prs wakes for the stale sweep with no pull request waiting (#3739)", async t => {
  const { store } = await roomStore(t);
  const job = jobByName("claim-prs");
  store.workClaims.configure("commons", { staleSweep: true });
  store.workClaims.set("commons", createWork({ id: "dormant" }, { now: OLD, agentId: "alice" }));
  assert.equal(jobEnabled(job, {}, store), true);
  assert.equal(jobIsDue(job, store, NOW, undefined), true);
  await job.run(store, { env: {}, deadline: Infinity });
  assert.equal(store.workClaims.get("commons", "dormant").state, "closed");
  const closedEvents = store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all("commons")
    .map(row => JSON.parse(row.body))
    .filter(event => event.type === "work_claim.updated" && JSON.stringify(event).includes("\"dormant\"") && JSON.stringify(event).includes("\"closed\""));
  assert.equal(closedEvents.length, 1, "exactly one closed event for the retired item");
});

test("claim-prs arms a future wake for an item that is not dormant yet", async t => {
  const { store } = await roomStore(t);
  const job = jobByName("claim-prs");
  store.workClaims.configure("commons", { staleSweep: true });
  store.workClaims.set("commons", createWork({ id: "fresh" }, { now: NOW - DAY, agentId: "alice" }));
  assert.equal(jobEnabled(job, {}, store), true);
  assert.equal(jobIsDue(job, store, NOW, undefined), false);
  assert.equal(jobNextDue(job, store, NOW, undefined), NOW - DAY + STALE_UNCLAIMED_DAYS * DAY);
});

test("a backlog drains one bounded batch per sweep interval under the tick", async t => {
  const { store } = await roomStore(t);
  store.workClaims.configure("commons", { staleSweep: true });
  for (let i = 0; i < STALE_SWEEP_BATCH + 5; i += 1) {
    store.workClaims.set("commons", createWork({ id: `b-${i}` }, { now: OLD - i * 1000, agentId: "alice" }));
  }
  const fetchImpl = async () => { throw new Error("no GitHub call expected"); };
  await syncClaimPullRequests(store, { fetchImpl, token: null, nowMs: NOW });
  assert.equal(store.workClaims.list("commons").filter(item => item.state === "closed").length, STALE_SWEEP_BATCH);
  assert.equal(staleSweepDueAt(store, NOW), NOW + STALE_SWEEP_INTERVAL_MS,
    "the remainder waits one interval, not the next scheduler tick");
  await syncClaimPullRequests(store, { fetchImpl, token: null, nowMs: NOW + STALE_SWEEP_INTERVAL_MS });
  assert.equal(store.workClaims.list("commons").filter(item => item.state === "closed").length, STALE_SWEEP_BATCH + 5);
  assert.equal(staleSweepDueAt(store, NOW + STALE_SWEEP_INTERVAL_MS), null);
  await syncClaimPullRequests(store, { fetchImpl, token: null, nowMs: NOW + 2 * STALE_SWEEP_INTERVAL_MS });
  assert.equal(store.workClaims.list("commons").filter(item => item.state === "closed").length, STALE_SWEEP_BATCH + 5,
    "repeat ticks close nothing twice");
});
