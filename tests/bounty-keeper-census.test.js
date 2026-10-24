// Tests for the keeper stuck-state census (#4128): the `unreachable`
// count in the escrow-epochs summary, the wake wiring that keeps it
// visible, and the degraded grade in job health.
//
// The classification test is the standing HUNT-COVERAGE rule applied to
// the due-scan: EVERY settlement-path state, crossed with its timestamp
// shapes, is pinned to exactly one owner — due-now, due-later, the
// census, or out of scope (terminal). A state the census claims that a
// due branch can actually reach would cry wolf; a reachable-by-nobody
// state missing from the census is the #4128 bug itself (an accepted
// bounty with challenge_ends_ms NULL sat invisible: due 0, overdue 0,
// no surface complaining).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { escrowEpochNextDueAt, escrowUnreachableCount, progressEscrowEpochs } from "../server/bounty-epoch-keeper.mjs";
import { jobByName, jobEnabled, jobNextDue } from "../server/jobs.mjs";
import { applyOutcomes, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const CODEX = "id:agent/codex";
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const isoNow = () => new Date(nowMs).toISOString();

function makeWorld(room) {
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

function post(world, { amount = 10, deadlineMs = 30 * DAY_MS } = {}) {
  return world.escrow.postBounty(world.room,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(deadlineMs), verifierId: INSTINCT }).bounty;
}
function toFunded(world, bounty) { world.escrow.fundBounty(world.room, bounty.bountyId, { funder: JILL }); return bounty; }
function toClaimed(world, bounty) {
  toFunded(world, bounty);
  world.escrow.claimBounty(world.room, bounty.bountyId, { claimant: GROK });
  return bounty;
}
function toSubmitted(world, bounty) {
  toClaimed(world, bounty);
  world.escrow.submitWork(world.room, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  return bounty;
}
function toAccepted(world, bounty) {
  toSubmitted(world, bounty);
  world.escrow.acceptWork(world.room, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: isoNow(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return world.escrow.getBounty(world.room, bounty.bountyId);
}
function toDisputed(world, bounty) {
  const accepted = toAccepted(world, bounty);
  world.escrow.disputeBounty(world.room, accepted.bountyId, { challenger: CODEX, bond: 2.5, grounds: "nitpick" });
  return world.escrow.getBounty(world.room, accepted.bountyId);
}
const sql = (world, text, ...params) => world.db.prepare(text).run(...params);

// One bounty per world, so the room-level reads classify the bounty.
function classify(world) {
  if (escrowUnreachableCount(world.store) > 0) return "unreachable";
  const due = escrowEpochNextDueAt(world.store, nowMs);
  if (due == null) return "none";
  return due <= nowMs ? "due-now" : "due-later";
}

test("due-scan membership: every settlement-path state is owned by a branch, the census, or neither (terminal)", () => {
  const cases = [];
  const run = (name, build, expected) => cases.push([name, build, expected]);

  run("proposed, deadline ahead", w => post(w), "due-later");
  run("proposed, deadline passed", w => { const b = post(w, { deadlineMs: HOUR_MS }); tick(2 * HOUR_MS); return b; }, "due-now");
  run("funded, deadline ahead", w => toFunded(w, post(w)), "due-later");
  run("funded, deadline passed", w => { const b = toFunded(w, post(w, { deadlineMs: HOUR_MS })); tick(2 * HOUR_MS); return b; }, "due-now");
  run("claimed, deadline ahead", w => toClaimed(w, post(w)), "due-later");
  run("claimed, deadline passed", w => { const b = toClaimed(w, post(w, { deadlineMs: HOUR_MS })); tick(2 * HOUR_MS); return b; }, "due-now");
  run("submitted, deadline ahead", w => toSubmitted(w, post(w)), "due-later");
  run("submitted, deadline passed", w => { const b = toSubmitted(w, post(w, { deadlineMs: HOUR_MS })); tick(2 * HOUR_MS); return b; }, "due-now");
  run("accepted, challenge window open", w => toAccepted(w, post(w)), "due-later");
  run("accepted, challenge window passed", w => { const b = toAccepted(w, post(w)); tick(4 * DAY_MS); return b; }, "due-now");
  run("accepted, challenge_ends_ms NULL (#4128 repro)", w => {
    const b = toAccepted(w, post(w));
    sql(w, "UPDATE bounty_records SET challenge_ends_ms = NULL WHERE room_id=? AND bounty_id=?", w.room, b.bountyId);
    return b;
  }, "unreachable");
  run("disputed, open and recent", w => toDisputed(w, post(w)), "due-later");
  run("disputed, open past the 14-day timeout", w => { const b = toDisputed(w, post(w)); tick(15 * DAY_MS); return b; }, "due-now");
  run("disputed, dispute record already terminal", w => {
    const b = toDisputed(w, post(w));
    sql(w, "UPDATE bounty_disputes SET body = json_set(body, '$.data.state', 'resolved') WHERE dispute_id = ?", b.disputeId);
    return b;
  }, "due-now");
  run("disputed, dispute_id NULL", w => {
    const b = toDisputed(w, post(w));
    sql(w, "UPDATE bounty_records SET dispute_id = NULL WHERE room_id=? AND bounty_id=?", w.room, b.bountyId);
    return b;
  }, "unreachable");
  run("disputed, resolution already recorded", w => {
    const b = toDisputed(w, post(w));
    sql(w, "UPDATE bounty_records SET resolution_json = ? WHERE room_id=? AND bounty_id=?",
      JSON.stringify({ kind: "release" }), w.room, b.bountyId);
    return b;
  }, "unreachable");
  run("approved, awaiting sweep", w => {
    const b = toAccepted(w, post(w));
    tick(4 * DAY_MS);
    w.escrow.closeEpoch(w.room, {});
    assert.equal(w.escrow.getBounty(w.room, b.bountyId).state, "approved");
    return b;
  }, "due-now");
  run("paid (terminal)", w => {
    const b = toAccepted(w, post(w));
    tick(4 * DAY_MS);
    w.escrow.closeEpoch(w.room, {});
    w.escrow.closeEpoch(w.room, {});
    assert.equal(w.escrow.getBounty(w.room, b.bountyId).state, "paid");
    return b;
  }, "none");
  run("refunded (terminal)", w => {
    const b = toSubmitted(w, post(w));
    w.escrow.rejectWork(w.room, b.bountyId, { rejector: JILL, reason: "does not meet the criteria" });
    return b;
  }, "none");
  run("cancelled (terminal)", w => {
    const b = post(w);
    w.escrow.declineBounty(w.room, b.bountyId, { decliner: JILL, reason: "no longer needed" });
    return b;
  }, "none");

  for (const [name, build, expected] of cases) {
    const world = makeWorld(`room-${name.replace(/[^a-z]+/gi, "-").toLowerCase()}`);
    build(world);
    assert.equal(classify(world), expected, `${name}: expected ${expected}`);
  }
});

test("the #4128 repro: an unreachable-only room reports unreachable: 1 on the first keeper pass", () => {
  const world = makeWorld("room-census-repro");
  const bounty = toAccepted(world, post(world));
  sql(world, "UPDATE bounty_records SET challenge_ends_ms = NULL WHERE room_id=? AND bounty_id=?",
    world.room, bounty.bountyId);
  const summary = progressEscrowEpochs(world.store, { now: nowMs, escrow: world.escrow });
  assert.equal(summary.due, 0);
  assert.equal(summary.unreachable, 1);
  // Observation only: the pass settled nothing and moved no money.
  assert.equal(world.escrow.getBounty(world.room, bounty.bountyId).state, "accepted");
});

test("a healthy room reports unreachable: 0", () => {
  const world = makeWorld("room-census-healthy");
  toAccepted(world, post(world));
  const summary = progressEscrowEpochs(world.store, { now: nowMs, escrow: world.escrow });
  assert.equal(summary.unreachable, 0);
});

test("wake wiring: an unreachable-only room keeps the job enabled on an hourly census wake; an idle room rests", () => {
  const job = jobByName("escrow-epochs");
  const stuck = makeWorld("room-census-wake");
  const bounty = toAccepted(stuck, post(stuck));
  sql(stuck, "UPDATE bounty_records SET challenge_ends_ms = NULL WHERE room_id=? AND bounty_id=?",
    stuck.room, bounty.bountyId);
  assert.equal(jobEnabled(job, {}, stuck.store), true);
  const before = Date.now();
  const next = jobNextDue(job, stuck.store, before);
  assert.ok(next > before && next <= before + HOUR_MS + 1000, `census wake within the hour, got ${next - before}ms out`);
  const idle = makeWorld("room-census-idle");
  assert.equal(jobEnabled(job, {}, idle.store), false);
  assert.equal(jobNextDue(job, idle.store, Date.now()), null);
});

test("job health grades escrow-epochs degraded with escrow_unreachable while the census is non-zero", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const state = applyOutcomes({}, [
    { job: "escrow-epochs", ok: true, at: now, summary: { rooms: 0, due: 0, unreachable: 2 } }
  ]);
  const view = jobHealthView(state, now);
  const epochs = view.jobs.find(job => job.name === "escrow-epochs");
  assert.equal(epochs.degraded, "escrow_unreachable");
  assert.equal(epochs.status, "degraded");
  const clean = applyOutcomes({}, [
    { job: "escrow-epochs", ok: true, at: now, summary: { rooms: 1, due: 1, unreachable: 0 } }
  ]);
  const cleanEpochs = jobHealthView(clean, now).jobs.find(job => job.name === "escrow-epochs");
  assert.equal(cleanEpochs.degraded, null);
  assert.equal(cleanEpochs.status, "ok");
});
