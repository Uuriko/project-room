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
import { sweepStaleUnclaimedClaims, syncClaimPullRequests, STALE_SWEEP_INTERVAL_MS } from "../server/claim-pr-sync.mjs";
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

test("the cron tick sweeps dormant unclaimed items, emits closed events, and throttles", async t => {
  const { store } = await roomStore(t);
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
