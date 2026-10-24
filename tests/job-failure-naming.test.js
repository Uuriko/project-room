// Job failure NAMING (RQ-22): generalising #3624 beyond the integrity
// job. When a job's failure is scoped to one record, the record's id
// rides the job's failure detail — taken from the structured record in
// scope at the failure site, never parsed out of an error message — so
// the wedged record is reachable from the stored failure detail and the
// operator surfaces, not only from a console log line. The exposure
// discipline is #3624/#3334's, unchanged: the public health view never
// projects the id and public error strings stay id-free.
//
// This file pins the two jobs whose failures are record-scoped at the
// failure site today: patrol (a room whose stored state it cannot
// process — the live wedge) and escrow-epochs (a bounty closeEpoch
// isolates). The remaining charter jobs' failures are deliberately
// counted-not-failed at their sites (#3464/#3893 convention) or never
// record-scoped; their exclusions and reasons are recorded in the RQ-22
// PR body, not silently dropped.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { runPatrolTick } from "../server/patrol.mjs";
import { jobByName } from "../server/jobs.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { progressEscrowEpochs } from "../server/bounty-epoch-keeper.mjs";
import {
  applyOutcomes, jobHealthView, runCronJobs, sanitizeFailureDetail
} from "../cloudflare/job-heartbeat.mjs";

// ---- patrol ------------------------------------------------------------

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-job-naming-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function post(store, roomId, id, body) {
  const key = store.issueAccessKey(roomId, "owner");
  store.command(key, roomId, { id: `cmd-${id}`, type: "message.posted", data: { body, messageId: id } });
}

function poisonedStore(t) {
  const store = openStore(t);
  store.initialize(initialRoom("aaa-healthy"));
  store.initialize(initialRoom("zzz-poison"));
  post(store, "aaa-healthy", "h1", "healthy room message");
  post(store, "zzz-poison", "p1", "poison room message");
  // The production wedge shape: the stored projection no longer parses,
  // so the patrol's agreement leg throws for this room while healthy
  // rooms patrol normally.
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='zzz-poison'").run("{corrupt-projection");
  return store;
}

test("patrol: the wedged room is named on the stored failure detail; the public view and error string stay id-free", async t => {
  const store = poisonedStore(t);

  // The fresh park (#3988) surfaces once as this tick's named failure:
  // the failure detail names the room; the public string carries only
  // the error's class.
  const result = runPatrolTick(store, {});
  assert.equal(result.errors, 1, "the wedged room fails the tick");
  assert.ok(result.checked >= 1, "the healthy room was still patrolled");
  assert.equal(result.failureDetail.code, "patrol_error");
  assert.equal(result.failureDetail.recordClass, "room");
  assert.equal(result.failureDetail.errorClass, "SyntaxError");
  assert.equal(result.failureDetail.recordId, "zzz-poison", "the job detail names the wedged room");
  assert.ok(!result.scanError.includes("zzz-poison"), "the public error string carries no room id");

  // A standing park does not re-fail the tick (#3988): it rides the
  // numeric parked count in the summary instead.
  const second = runPatrolTick(store, {});
  assert.equal(second.errors, undefined, "a standing park does not re-fail the tick");
  assert.equal(second.parked, 1);

  // The heartbeat chain, on a fresh store so its first tick is the
  // fresh park: the stored record (the operator surface) keeps the name
  // through both sanitizers; the public health view built from it does
  // not project it.
  const cronStore = poisonedStore(t);
  const outcomes = await runCronJobs(
    { patrol: () => jobByName("patrol").run(cronStore, { deadline: Date.now() + 5000 }) },
    { now: () => Date.now(), log: () => {} }
  );
  const stored = applyOutcomes({}, outcomes);
  assert.equal(stored.patrol.lastFailure.recordId, "zzz-poison", "the stored failure detail names the room");
  const view = jobHealthView(stored, Date.now()).jobs.find(job => job.name === "patrol");
  assert.equal(view.lastErrorCode, "patrol_error");
  assert.equal(view.lastErrorRecordId, undefined, "the public health view carries no record id");
  assert.ok(!JSON.stringify(view).includes("zzz-poison"), "the public health view contains no room id");
});

// ---- escrow-epochs -----------------------------------------------------
// Construction mirrors tests/bounty-epoch-keeper.test.js: an in-memory
// store double and the escrow journal seam (_append) as the poison point.

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const DAY_MS = 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld(room = ROOM) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(room);
  return { store, db, escrow, room };
}

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

test("escrow-epochs: an isolated per-bounty failure names the bounty on the failure detail", () => {
  const world = makeWorld();
  const { escrow } = world;
  const poisoned = runToAccepted(world);
  const healthy = runToAccepted(world);
  nowMs += 4 * DAY_MS; // past the 3-day challenge window: both are due
  // Poison: every journal append for the one bounty throws (the #3275
  // seam). closeEpoch isolates it into its summary with the bounty id
  // structured — the keeper names that id, it does not parse an error.
  const original = escrow._append.bind(escrow);
  escrow._append = args => {
    if (args.bountyId === poisoned.bountyId) throw new Error("injected journal append failure");
    return original(args);
  };
  const result = progressEscrowEpochs(world.store, { now: nowMs, escrow });
  assert.equal(result.failed, 1, "the poisoned bounty is recorded, not swallowed");
  assert.equal(result.errors, 1);
  assert.equal(result.approved, 1, "the healthy bounty still progressed");
  assert.equal(result.failureDetail.code, "escrow_epoch_failed");
  assert.equal(result.failureDetail.recordId, poisoned.bountyId, "the detail names the failed bounty");
  assert.notEqual(result.failureDetail.recordId, healthy.bountyId);

  // The sanitizer passes the id to the stored detail; the public health
  // view built from that stored record does not project it.
  const clean = sanitizeFailureDetail(result.failureDetail);
  assert.equal(clean.recordId, poisoned.bountyId);
  const stored = { "escrow-epochs": {
    lastRunAt: nowMs, lastErrorAt: nowMs, lastError: "1 error(s) in tick",
    consecutiveFailures: 1, lastFailure: clean
  } };
  const view = jobHealthView(stored, nowMs).jobs.find(job => job.name === "escrow-epochs");
  assert.equal(view.lastErrorCode, "escrow_epoch_failed");
  assert.equal(view.lastErrorRecordId, undefined, "the public health view carries no record id");
  assert.ok(!JSON.stringify(view).includes(poisoned.bountyId), "the public health view contains no bounty id");
});

test("escrow-epochs: a failed entry whose id is not id-shaped is never attached", () => {
  const world = makeWorld();
  runToAccepted(world);
  nowMs += 4 * DAY_MS;
  const stub = { closeEpoch: () => ({ summary: {
    approved: [], swept: [], refunded: [], released: [], expiredUnfunded: [],
    failed: [{ bountyId: "not an id: free text with spaces", code: "error", message: "x" }]
  } }) };
  const result = progressEscrowEpochs(world.store, { now: nowMs, escrow: stub });
  assert.equal(result.failed, 1);
  assert.equal(result.failureDetail, undefined, "a non-id-shaped value never rides the detail");
});

// ---- the channel -------------------------------------------------------

test("channel: the sanitizer drops a non-id-shaped recordId", () => {
  const dirty = sanitizeFailureDetail({
    code: "patrol_error", subcheck: "patrol", recordId: "room id with spaces and a body: hello"
  });
  assert.equal(dirty.recordId, undefined, "a non-id recordId never rides the channel");
});
