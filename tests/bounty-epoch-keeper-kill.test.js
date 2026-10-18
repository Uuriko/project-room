// Tests for the dedicated escrow keeper kill flag (AUDIT C-08 step-3
// remainder, M-1): the scheduled keeper (escrow-epochs, #3865) had no
// surgical halt — the only pause was the deployment-wide maintenance
// mode, which stops far more than the keeper. The flag is operator-set
// (operator-token surface, the same authority class as the operator
// purge/status routes), in two scopes in one table: a global row and
// per-room rows. While set, keeper passes skip cleanly (no closes, no
// errors); the /api/health/jobs escrow-epochs entry carries the killed
// state and its since-timestamp; unsetting resumes at the normal
// one-close-per-room-per-tick rate (no catch-up storm).
//
// World construction mirrors tests/bounty-epoch-keeper.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import {
  progressEscrowEpochs, escrowKeeperKillState, escrowKeeperHealth,
  setEscrowKeeperKill, clearEscrowKeeperKill
} from "../server/bounty-epoch-keeper.mjs";
import { jobByName } from "../server/jobs.mjs";
import { jobHealthView, runCronJobs, applyOutcomes } from "../cloudflare/job-heartbeat.mjs";
import { createOperatorRoutes } from "../server/operator-routes.mjs";
import { ensureOperatorActionsSchema, listOperatorActions } from "../server/operator-actions.mjs";

const ROOM = "room-test";
const OTHER = "room-other";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const DAY_MS = 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld(room = ROOM) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction, now: () => nowMs };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(room);
  return { store, db, escrow, room };
}

const bal = (escrow, room, lane) => escrow.balances(room, lane);
const keeper = (world) => progressEscrowEpochs(world.store, { now: nowMs, escrow: world.escrow });

function runToAccepted(world, room = world.room) {
  const bounty = world.escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(30 * DAY_MS) }).bounty;
  world.escrow.fundBounty(room, bounty.bountyId, { funder: JILL });
  world.escrow.claimBounty(room, bounty.bountyId, { claimant: GROK });
  world.escrow.submitWork(room, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  world.escrow.acceptWork(room, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return world.escrow.getBounty(room, bounty.bountyId);
}

test("global kill: a due epoch does NOT close while set, and the tick is not a failure", () => {
  const world = makeWorld();
  const { escrow, room } = world;
  const bounty = runToAccepted(world);
  tick(4 * DAY_MS); // challenge window (3 days) fully passed: due
  const balancesBefore = bal(escrow, room, GROK);

  setEscrowKeeperKill(world.store, { by: "operator", now: nowMs });
  const killed = keeper(world);
  assert.equal(killed.killed, 1, "the tick reports itself killed");
  assert.equal(killed.skipped, 1);
  assert.equal(killed.errors, 0, "a deliberate halt is not an error");
  assert.equal(killed.failed, 0, "failure counters must not inflate");
  assert.equal(killed.approved, 0);
  assert.equal(killed.paid, 0);
  assert.equal(killed.due, 1, "the waiting work is still counted, not hidden");
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "accepted", "no epoch closed");
  assert.deepEqual(bal(escrow, room, GROK), balancesBefore, "balances unchanged while killed");

  // Resume: the same epoch closes, at the normal two-step rate — the
  // approving pass does not also sweep (no catch-up storm).
  clearEscrowKeeperKill(world.store, {});
  const first = keeper(world);
  assert.equal(first.approved, 1);
  assert.equal(first.paid, 0, "resume keeps the two-step close: sweep is next tick's work");
  const second = keeper(world);
  assert.equal(second.paid, 1);
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "paid");
  assert.equal(bal(escrow, room, GROK).payable, 109.9);
});

test("per-room kill: that room's epoch holds, other rooms close normally", () => {
  const world = makeWorld();
  const { escrow, store, room } = world;
  escrow.ensureGenesis(OTHER);
  const held = runToAccepted(world, room);
  const free = runToAccepted(world, OTHER);
  tick(4 * DAY_MS);

  setEscrowKeeperKill(store, { roomId: room, by: "operator", now: nowMs });
  const summary = keeper(world);
  assert.equal(summary.killed, 1);
  assert.equal(summary.killedRooms, 1);
  assert.equal(summary.errors, 0);
  assert.equal(summary.approved, 1, "the unkilled room still progressed");
  assert.equal(escrow.getBounty(room, held.bountyId).state, "accepted", "killed room held");
  assert.equal(escrow.getBounty(OTHER, free.bountyId).state, "approved", "other room closed its epoch");

  clearEscrowKeeperKill(store, { roomId: room });
  const resumed = keeper(world);
  assert.equal(resumed.approved, 1, "the held room resumes on the next pass");
  assert.equal(escrow.getBounty(room, held.bountyId).state, "approved");
});

test("kill state: set is idempotent (first set wins the since), clear removes exactly its scope", () => {
  const world = makeWorld();
  const { store } = world;
  assert.deepEqual(escrowKeeperKillState(store), { global: null, rooms: [] });

  setEscrowKeeperKill(store, { by: "operator", now: nowMs });
  const firstGlobal = escrowKeeperKillState(store).global;
  assert.equal(firstGlobal.killedAt, nowMs);
  tick(60_000);
  setEscrowKeeperKill(store, { by: "operator", now: nowMs });
  assert.equal(escrowKeeperKillState(store).global.killedAt, firstGlobal.killedAt,
    "re-setting an already-killed scope keeps the original since-timestamp");

  setEscrowKeeperKill(store, { roomId: ROOM, by: "operator", now: nowMs });
  clearEscrowKeeperKill(store, {});
  const after = escrowKeeperKillState(store);
  assert.equal(after.global, null, "global clear removes the global row");
  assert.equal(after.rooms.length, 1, "the per-room row is a separate scope and survives");
  assert.equal(after.rooms[0].roomId, ROOM);
});

test("health surface: the escrow-epochs entry pins the killed state and its since-timestamp", async () => {
  const world = makeWorld();
  const { store } = world;
  runToAccepted(world);
  tick(4 * DAY_MS);
  const killAt = nowMs;
  setEscrowKeeperKill(store, { by: "operator", now: killAt });
  setEscrowKeeperKill(store, { roomId: ROOM, by: "operator", now: killAt + 1000 });

  const health = escrowKeeperHealth(store);
  assert.equal(health.killed, true);
  assert.equal(health.global, true);
  assert.equal(health.globalSince, new Date(killAt).toISOString());
  assert.equal(health.since, new Date(killAt).toISOString(), "since is the earliest kill in force");
  assert.equal(health.killedRooms, 1);
  assert.equal(health.roomSince, new Date(killAt + 1000).toISOString());

  // The /api/health/jobs view (worker) carries it on the escrow-epochs
  // entry only, with no room id projected onto the public surface.
  const view = jobHealthView({}, nowMs, {}, store);
  const entry = view.jobs.find(job => job.name === "escrow-epochs");
  assert.deepEqual(entry.keeperKill, health);
  assert.ok(!JSON.stringify(entry.keeperKill).includes(ROOM), "room ids stay off the public health view");
  for (const job of view.jobs) {
    if (job.name !== "escrow-epochs") assert.equal(job.keeperKill, undefined);
  }

  // A killed tick recorded through the heartbeat is a success, not a
  // failure: the job entry must not read failing/stale for a halt.
  const job = jobByName("escrow-epochs");
  assert.ok(job);
  const outcomes = await runCronJobs({ "escrow-epochs": () => keeper(world) }, { log() {} });
  assert.equal(outcomes[0].ok, true, "the killed tick records as ok");
  assert.equal(outcomes[0].summary.killed, 1, "the heartbeat summary carries the killed marker");
  const stored = applyOutcomes({}, outcomes);
  const afterTick = jobHealthView(stored, nowMs, {}, store).jobs.find(job => job.name === "escrow-epochs");
  assert.equal(afterTick.consecutiveFailures, 0);
  assert.equal(afterTick.status, "ok");
  assert.equal(afterTick.keeperKill.killed, true);

  clearEscrowKeeperKill(store, {});
  clearEscrowKeeperKill(store, { roomId: ROOM });
  const cleared = jobHealthView({}, nowMs, {}, store).jobs.find(job => job.name === "escrow-epochs");
  assert.deepEqual(cleared.keeperKill,
    { killed: false, global: false, since: null, globalSince: null, killedRooms: 0, roomSince: null });
});

test("the registered escrow-epochs job run path honours the kill (node + worker delegation point)", async () => {
  const world = makeWorld();
  const { escrow, store, room } = world;
  const bounty = runToAccepted(world);
  store.bountyEscrow = escrow; // the production store wiring (store.mjs)
  tick(4 * DAY_MS);
  setEscrowKeeperKill(store, { by: "operator", now: nowMs });
  const job = jobByName("escrow-epochs");
  const killed = await job.run(store, { now: () => nowMs });
  assert.equal(killed.killed, 1);
  assert.equal(killed.errors, 0);
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "accepted");
  clearEscrowKeeperKill(store, {});
  const resumed = await job.run(store, { now: () => nowMs });
  assert.equal(resumed.approved, 1);
});

test("operator surface: kill/resume need the operator token, scope the flag, and validate input", async () => {
  const TOKEN = "operator-test-token-0123456789abcdef";
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
  try {
    const world = makeWorld();
    const { store } = world;
    ensureOperatorActionsSchema(store.db); // store open does this in production
    const routes = createOperatorRoutes({
      store,
      json: (res, status, payload) => { res.statusCode = status; res.payload = payload; },
      reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
      body: async req => req.bodyData,
      rate: () => {}
    });
    const call = async (path, { method = "POST", token = TOKEN, data } = {}) => {
      const req = { method, headers: { authorization: token ? `Operator ${token}` : undefined }, bodyData: data };
      const res = { setHeader() {} };
      try {
        const handled = await routes(req, res, { url: new URL(path, "http://operator.test"), remoteAddress: "127.0.0.1", requestId: "kill-test" });
        return { handled, status: res.statusCode ?? 200, body: res.payload };
      } catch (error) {
        return { handled: true, status: error.status, code: error.code };
      }
    };

    // No token and wrong token: the surface does not exist (404, like
    // every other operator route).
    assert.equal((await call("/api/operator/escrow-keeper/kill", { token: null, data: {} })).status, 404);
    assert.equal((await call("/api/operator/escrow-keeper/kill", { token: "not-the-operator-token-0123456789abcd", data: {} })).status, 404);
    assert.deepEqual(escrowKeeperKillState(store), { global: null, rooms: [] }, "refused calls set nothing");

    // Global kill, then readback.
    const killed = await call("/api/operator/escrow-keeper/kill", { data: { reason: "bad sweep drill" } });
    assert.equal(killed.status, 200, JSON.stringify(killed.body));
    assert.equal(killed.body.killed, true);
    assert.equal(killed.body.scope, "global");
    assert.equal(killed.body.global.since, new Date(nowMs).toISOString());
    const status = await call("/api/operator/escrow-keeper", { method: "GET" });
    assert.equal(status.body.global.since, new Date(nowMs).toISOString());

    // Per-room kill + invalid scopes.
    const roomKill = await call("/api/operator/escrow-keeper/kill", { data: { roomId: ROOM } });
    assert.equal(roomKill.body.scope, ROOM);
    assert.equal(roomKill.body.rooms.length, 1);
    assert.equal((await call("/api/operator/escrow-keeper/kill", { data: { roomId: "bad room!" } })).status, 422);
    assert.equal((await call("/api/operator/escrow-keeper/kill", { data: { roomId: ROOM, extra: 1 } })).status, 422);

    // Resume clears exactly the named scope.
    const resumed = await call("/api/operator/escrow-keeper/resume", { data: {} });
    assert.equal(resumed.body.global, null);
    assert.equal(resumed.body.rooms.length, 1, "the per-room kill survives the global resume");
    const resumedRoom = await call("/api/operator/escrow-keeper/resume", { data: { roomId: ROOM } });
    assert.equal(resumedRoom.body.killed, false);
    assert.deepEqual(escrowKeeperKillState(store), { global: null, rooms: [] });

    // Every change landed in the operator audit, scoped and reasoned.
    const actions = listOperatorActions(store, 10)
      .filter(action => action.targetKind === "escrow_keeper");
    // All four rows share one frozen-clock `at`, so their list order is
    // by random id: compare as a set of (action, target, result).
    assert.deepEqual(
      actions.map(action => [action.action, action.targetId, action.result].join(":")).sort(), [
        "escrow_keeper.kill:global:killed",
        `escrow_keeper.kill:${ROOM}:killed`,
        "escrow_keeper.resume:global:resumed",
        `escrow_keeper.resume:${ROOM}:resumed`
      ]);
    assert.equal(actions.find(action => action.targetId === "global" && action.action === "escrow_keeper.kill").reason,
      "bad sweep drill");
  } finally {
    delete process.env.ROOM_OPERATOR_TOKEN_SHA256;
  }
});
