// PRODUCT-200 reliability — model-based differential tester.
//
// Drives the INDEPENDENT claim-lifecycle model (claim-lifecycle-model.mjs)
// and the REAL implementation over the same op sequences and compares
// outcomes after every op. Any divergence is either an implementation bug or
// a model error — each is classified by signature below.
//
// Two layers:
//   1. route level — model vs handleWorkClaims (the real HTTP route handler).
//      This is where the QA-200 failure sequences live (E5/A3/B24).
//   2. pure level — model vs server/work-claims.mjs pure functions under a
//      virtual clock (lease/renew/sweep interleavings the route layer can't
//      reach deterministically).
//
// Op sequences are deterministic: a fixed PRNG seed (override with
// CHAOS_MODEL_SEED) plus deterministic prefixes that replay the seed corpus.
// Scale via CHAOS_MODEL_SEQUENCES / CHAOS_MODEL_OPS (nightly runs more).
//
// Known divergence signatures (the seed-corpus bugs, reproduced here
// independently — "fail-first" at the model level):
//   E5:stale-release-accepted   — model refuses work_claim_conflict, impl applies
//   A3:retry-appended-history   — model no-ops an identical retry, impl appends
//   B24:no-board-events         — model journals work_claim.*, impl journals none
// The test asserts every known signature is observed at least once (the
// harness still detects the bugs) and that NO unknown signature appears.
// When a fix lands, its signature vanishes and this test fails — forcing the
// manifest update, after which the model becomes a pure regression oracle.
//
// Test-audit gate: the contract is the documented lifecycle (independent
// model); the credible regression is any lifecycle-contract breakage; no
// existing test covers the op cross-product (handwritten tests enumerate
// paths; this covers random interleavings of claim/release/reassign/attest/
// renew/sweep). No production seams: drives the real handler + pure
// functions through their existing entry points.
import test from "node:test";
import assert from "node:assert/strict";
import { createBoard } from "./claim-lifecycle-model.mjs";
import { makeBoardWorld } from "./world.mjs";
import {
  createWork, claimWork, updateWork, attestWork, reassignWork,
  renewWork, releaseExpired,
} from "../../server/work-claims.mjs";

// --- deterministic PRNG (mulberry32) ---------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.env.CHAOS_MODEL_SEED ?? 20261008);
const SEQUENCES = Number(process.env.CHAOS_MODEL_SEQUENCES ?? 150);
const MAX_OPS = Number(process.env.CHAOS_MODEL_OPS ?? 20);

const AGENTS = ["alice", "bob"];
const NOTES = ["alpha", "beta", "gamma"];
const STATE_TARGETS = ["in_progress", "blocked", "claimed", "done", "unclaimed"];
const IDS = ["m-w1", "m-w2", "m-w3"];

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// --- implementation projections ---------------------------------------------
const projectImplItem = item => item == null ? null : ({
  state: item.state,
  owner: item.owner,
  historyLen: item.history.length,
  claimedRounds: item.history.filter(h => h.action === "claimed").length,
  actions: item.history.map(h => `${h.action}:${h.agentId}`),
  attestations: [...(item.attestations ?? []).map(a => a.memberId)],
  leaseExpiresAt: item.leaseExpiresAt ?? null,
});

// --- model op application (shared by both layers) ----------------------------
function applyModelOp(model, op, roundsOf) {
  switch (op.kind) {
    case "create": return model.create(op.id);
    case "claim": return model.claim(op.id, op.agent, { leaseHours: op.leaseHours });
    case "update-state":
      return model.update(op.id, op.agent, { state: op.target, expectedRound: roundOf(roundsOf, op) });
    case "update-note": return model.update(op.id, op.agent, { note: op.note });
    case "release":
      return model.update(op.id, op.agent, { state: "unclaimed", expectedRound: roundOf(roundsOf, op) });
    case "attest": return model.attest(op.id, op.agent);
    case "reassign": return model.reassign(op.id, op.agent, op.newOwner);
    case "renew": return model.renew(op.id, op.agent, { leaseHours: op.leaseHours });
    case "sweep": model.sweep(); return { ok: true, code: null };
    default: throw new Error(`unknown op ${op.kind}`);
  }
}
// The round the caller believes it holds: stale ops deliberately pass an old one.
function roundOf(roundsOf, op) {
  if (!("stale" in op) || op.id === undefined) return undefined;
  const current = roundsOf.get(op.id) ?? 0;
  return op.stale ? Math.max(0, current - 1) : current;
}

// --- route-layer driver ------------------------------------------------------
async function applyRouteOp(world, op) {
  switch (op.kind) {
    case "create": return world.call("create", { body: { id: op.id } });
    case "claim": return world.call("claim", { id: op.id, memberId: op.agent,
      body: op.leaseHours === undefined ? {} : { leaseHours: op.leaseHours } });
    case "update-state": return world.call("update", { id: op.id, memberId: op.agent, body: { state: op.target } });
    case "update-note": return world.call("update", { id: op.id, memberId: op.agent, body: { note: op.note } });
    case "release": return world.call("release", { id: op.id, memberId: op.agent, body: {} });
    case "attest": return world.call("review", { id: op.id, memberId: op.agent, body: {} });
    case "reassign": return world.call("reassign", { id: op.id, memberId: op.agent, body: { newOwner: op.newOwner } });
    default: throw new Error(`route driver has no op ${op.kind}`);
  }
}

function classifyRouteDivergence(op, m, p, mp, ip) {
  if (op.stale && op.kind === "release" && !m.ok && m.code === "work_claim_conflict" && p.ok)
    return "E5:stale-release-accepted";
  if (op.stale && op.kind === "update-state" && op.target === "unclaimed" && !m.ok && p.ok)
    return "E5:stale-release-accepted";
  if (op.kind === "update-note" && m.ok && p.ok && ip && mp &&
      ip.historyLen === mp.historyLen + 1 &&
      JSON.stringify(ip.actions.slice(0, -1)) === JSON.stringify(mp.actions))
    return "A3:retry-appended-history";
  const detail = `op=${JSON.stringify(op)} model=${JSON.stringify({ ok: m.ok, code: m.code, proj: mp })} ` +
    `impl=${JSON.stringify({ ok: p.ok, code: p.code, proj: ip })}`;
  return `UNKNOWN:${detail}`;
}

async function runRouteSequence(ops) {
  const world = makeBoardWorld({ roomId: "model-room" });
  const model = createBoard();
  const roundsOf = new Map(); // id -> model's current round (in sync until divergence)
  const divergences = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const m = applyModelOp(model, op, roundsOf);
    const p = await applyRouteOp(world, op);
    const mp = op.id === undefined ? null : model.project(op.id);
    const ip = op.id === undefined ? null : projectImplItem(world.read(op.id));
    // Lease timestamps are derived from different clocks (virtual vs real);
    // the lease EXPIRY behavior is compared at the pure level instead.
    const agree = m.ok === p.ok &&
      (m.ok || m.code === p.code) &&
      JSON.stringify(stripLease(mp)) === JSON.stringify(stripLease(ip));
    if (!agree) {
      divergences.push({ step: i, signature: classifyRouteDivergence(op, m, p, mp, ip), op });
      break; // states diverged — further comparison is meaningless
    }
    if (op.kind === "claim" && m.ok) roundsOf.set(op.id, model.get(op.id).round);
  }
  // B24: the model journals work_claim.* per committed write; the handler
  // journals nothing. Checked once per sequence; never stops the sequence.
  if (model.journal.length > 0 && world.journal.length === 0)
    divergences.push({ step: -1, signature: "B24:no-board-events", op: null });
  return divergences;
}

// --- pure-layer driver (virtual clock) ---------------------------------------
function applyPureOp(items, op, nowMs) {
  const get = id => {
    const item = items.get(id);
    if (!item) { const e = new Error("missing"); e.code = "work_claim_not_found"; throw e; }
    return item;
  };
  try {
    switch (op.kind) {
      case "create": items.set(op.id, createWork({ id: op.id }, { now: nowMs })); break;
      case "claim": items.set(op.id, claimWork(get(op.id), op.agent, { leaseHours: op.leaseHours, now: nowMs })); break;
      case "update-state": items.set(op.id, updateWork(get(op.id), op.agent, { state: op.target, now: nowMs })); break;
      case "update-note": items.set(op.id, updateWork(get(op.id), op.agent, { note: op.note, now: nowMs })); break;
      case "release": items.set(op.id, updateWork(get(op.id), op.agent, { state: "unclaimed", now: nowMs })); break;
      case "attest": items.set(op.id, attestWork(get(op.id), op.agent, { now: nowMs })); break;
      case "reassign": items.set(op.id, reassignWork(get(op.id), op.agent, op.newOwner, { now: nowMs })); break;
      case "renew": items.set(op.id, renewWork(get(op.id), op.agent, { leaseHours: op.leaseHours, now: nowMs })); break;
      case "sweep": {
        const out = releaseExpired([...items.values()], nowMs);
        items.clear();
        for (const item of out) items.set(item.id, item);
        break;
      }
      default: throw new Error(`pure driver has no op ${op.kind}`);
    }
    return { ok: true, code: null };
  } catch (error) {
    return { ok: false, code: error.code ?? "unknown" };
  }
}

function runPureSequence(ops) {
  // duplicateCreate:"overwrite" — at the pure layer createWork is a plain
  // constructor; the driver's Map.set overwrites, so the model does too.
  const model = createBoard({ duplicateCreate: "overwrite" });
  const items = new Map();
  const roundsOf = new Map();
  let nowMs = model.now.ms;
  const divergences = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "tick") { nowMs += 3600 * 1000; model.now.ms = nowMs; continue; }
    const m = applyModelOp(model, op, roundsOf);
    const p = applyPureOp(items, op, nowMs);
    const mp = op.id === undefined ? null : model.project(op.id);
    const ip = op.id === undefined ? null : projectImplItem(items.get(op.id) ?? null);
    // Pure layer refuses uniformly (ClaimError); compare ok-ness + projection.
    const agree = m.ok === p.ok && JSON.stringify(stripLease(mp)) === JSON.stringify(stripLease(ip));
    if (!agree) {
      divergences.push({ step: i, signature: classifyPureDivergence(op, m, p, mp, ip), op });
      break;
    }
    if (op.kind === "claim" && m.ok) roundsOf.set(op.id, model.get(op.id).round);
  }
  return divergences;
}
// Lease timestamps are wall-clock-shaped on both sides but derived
// identically; strip them from the comparison to avoid format coupling
// (the lease EXPIRY behavior is what matters, exercised via tick+sweep).
const stripLease = proj => proj === null ? null : { ...proj, leaseExpiresAt: undefined };

function classifyPureDivergence(op, m, p, mp, ip) {
  if (op.stale && (op.kind === "release" ||
      (op.kind === "update-state" && op.target === "unclaimed")) && !m.ok && p.ok)
    return "E5:stale-release-accepted";
  if (op.kind === "update-note" && m.ok && p.ok && ip && mp &&
      ip.historyLen === mp.historyLen + 1 &&
      JSON.stringify(ip.actions.slice(0, -1)) === JSON.stringify(mp.actions))
    return "A3:retry-appended-history";
  const detail = `op=${JSON.stringify(op)} model=${JSON.stringify({ ok: m.ok, code: m.code, proj: mp })} ` +
    `impl=${JSON.stringify({ ok: p.ok, code: p.code, proj: ip })}`;
  return `UNKNOWN:${detail}`;
}

// --- op generators -----------------------------------------------------------
function genRouteOp(rng, ctx) {
  const id = pick(rng, IDS);
  const agent = pick(rng, AGENTS);
  const roll = rng();
  const rounds = ctx.rounds.get(id) ?? 0;
  if (roll < 0.10) return { kind: "create", id };
  if (roll < 0.24) return { kind: "claim", id, agent,
    leaseHours: rng() < 0.12 ? pick(rng, [0, -3, 721, "x"]) : rng() < 0.15 ? pick(rng, [1, null]) : undefined };
  if (roll < 0.38) return { kind: "update-state", id, agent, target: pick(rng, STATE_TARGETS), stale: false };
  if (roll < 0.52) return { kind: "update-note", id, agent, note: pick(rng, NOTES) };
  if (roll < 0.62) return { kind: "attest", id, agent };
  if (roll < 0.76) return { kind: "release", id, agent, stale: rounds >= 2 && rng() < 0.35 };
  if (roll < 0.88) return { kind: "reassign", id, agent, newOwner: agent === "alice" ? "bob" : "alice" };
  // Occasionally drive update→unclaimed (the update-route release path) stale.
  return { kind: "update-state", id, agent, target: "unclaimed", stale: rounds >= 2 && rng() < 0.4 };
}

function genPureOp(rng) {
  const id = pick(rng, ["p-w1", "p-w2"]);
  const agent = pick(rng, AGENTS);
  const roll = rng();
  if (roll < 0.08) return { kind: "create", id };
  if (roll < 0.20) return { kind: "claim", id, agent,
    leaseHours: rng() < 0.15 ? pick(rng, [1, 2, null]) : undefined };
  if (roll < 0.32) return { kind: "update-state", id, agent, target: pick(rng, STATE_TARGETS), stale: false };
  if (roll < 0.44) return { kind: "update-note", id, agent, note: pick(rng, NOTES) };
  if (roll < 0.52) return { kind: "attest", id, agent };
  if (roll < 0.62) return { kind: "release", id, agent, stale: rng() < 0.3 };
  if (roll < 0.70) return { kind: "reassign", id, agent, newOwner: agent === "alice" ? "bob" : "alice" };
  if (roll < 0.78) return { kind: "renew", id, agent, leaseHours: rng() < 0.3 ? 2 : undefined };
  if (roll < 0.86) return { kind: "sweep", id: "p-w1" };
  if (roll < 0.94) return { kind: "tick" };
  return { kind: "update-state", id, agent, target: "unclaimed", stale: rng() < 0.4 };
}

// Deterministic prefixes: replay the seed corpus exactly, so the known bugs
// are hit on every run regardless of the random draw.
const PREFIX_E5 = [
  { kind: "create", id: "m-w1" },
  { kind: "claim", id: "m-w1", agent: "alice" },
  { kind: "release", id: "m-w1", agent: "alice", stale: false },
  { kind: "claim", id: "m-w1", agent: "alice" },
  { kind: "release", id: "m-w1", agent: "alice", stale: true },
];
const PREFIX_A3 = [
  { kind: "create", id: "m-w2" },
  { kind: "claim", id: "m-w2", agent: "alice" },
  { kind: "update-note", id: "m-w2", agent: "alice", note: "seed-note" },
  { kind: "update-note", id: "m-w2", agent: "alice", note: "seed-note" },
];

// --- the tests ----------------------------------------------------------------
const KNOWN = new Set(["E5:stale-release-accepted", "A3:retry-appended-history", "B24:no-board-events"]);

test("route-level differential: model vs handleWorkClaims over random op sequences", async t => {
  const seen = new Set();
  const unknown = [];
  // Deterministic prefixes first: the known bugs must reproduce every run.
  for (const prefix of [PREFIX_E5, PREFIX_A3]) {
    for (const d of await runRouteSequence(prefix)) {
      seen.add(d.signature);
      if (!KNOWN.has(d.signature)) unknown.push(d);
    }
  }
  const rng = mulberry32(SEED);
  for (let s = 0; s < SEQUENCES; s++) {
    const ctx = { rounds: new Map() };
    const ops = [];
    const n = 5 + Math.floor(rng() * MAX_OPS);
    for (let i = 0; i < n; i++) ops.push(genRouteOp(rng, ctx));
    for (const d of await runRouteSequence(ops)) {
      seen.add(d.signature);
      if (!KNOWN.has(d.signature)) unknown.push({ sequence: s, ...d });
    }
    if (unknown.length > 0) break;
  }
  t.diagnostic(`route-level: ${SEQUENCES} random sequences + 2 deterministic prefixes; signatures seen: ${[...seen].join(", ")}`);
  assert.deepEqual(unknown, [], `unknown divergences (bug or model error — investigate): ${JSON.stringify(unknown.slice(0, 3), null, 2)}`);
  for (const k of KNOWN) {
    assert.ok(seen.has(k), `known divergence ${k} was NOT observed — the fix may have landed; update the manifest`);
  }
});

test("pure-level differential: model vs work-claims.mjs under a virtual clock", async t => {
  const seen = new Set();
  const unknown = [];
  const rng = mulberry32(SEED ^ 0x9e3779b9);
  for (let s = 0; s < SEQUENCES; s++) {
    const ops = [];
    const n = 5 + Math.floor(rng() * MAX_OPS);
    for (let i = 0; i < n; i++) ops.push(genPureOp(rng));
    for (const d of runPureSequence(ops)) {
      seen.add(d.signature);
      if (!KNOWN.has(d.signature)) unknown.push({ sequence: s, ...d });
    }
    if (unknown.length > 0) break;
  }
  t.diagnostic(`pure-level: ${SEQUENCES} random sequences; signatures seen: ${[...seen].join(", ") || "(none)"}`);
  assert.deepEqual(unknown, [], `unknown divergences (bug or model error — investigate): ${JSON.stringify(unknown.slice(0, 3), null, 2)}`);
  // Pure level need not hit every known bug (B24 is route-level); it must at
  // least exercise the lifecycle without unknown divergences.
});
