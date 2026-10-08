// tests/fuzz-01-claim-opseq.test.js
// WAVE-400 one-shot fuzz worker — claim state-machine op-sequence fuzz.
//
// TEST-ONLY. Reads server/work-claims.mjs. Writes nothing outside this file.
// Target: the pure claim functions (createWork / claimWork / renewWork /
// updateWork / reassignWork / attestWork / closeWork / releaseExpired).
// Hand-rolled mulberry32 RNG; seed = Number(process.env.FUZZ_SEED ?? 20261008),
// printed at load. Deterministic per sequence: sequence s reseeds from
// (SEED, s), so any violation reproduces with FUZZ_SEED=<seed> + seq index.
//
// Invariants asserted after every op:
//  (a) at most one current owner per work (owner is null or a single id)
//  (b) claimedAt never moves backward (and is never cleared) for a work
//  (c) history is append-only (prefix preserved, stamps monotonic)
//  (d) terminal states (done/closed) are sinks — no legal op revives them
//      (NOTE: the brief named these completed/failed/cancelled; the module's
//      real terminal states are done/closed — those are what is fuzzed)
//  (e) rejected ops leave the input byte-identical (differential check);
//      successful ops never mutate their input either (purity check)
//  (f) oracle: ops the module's own rules mark legal must not be rejected
import { test } from "node:test";
import assert from "node:assert/strict";
import * as wc from "../server/work-claims.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-01] seed=${SEED}`);
const N_SEQUENCES = Number(process.env.FUZZ_SEQUENCES ?? 10000);
const MAX_VIOLATIONS = 25;
const BASE_NOW = 1760000000000; // fixed epoch base; per-sequence jitter added

// --- RNG -----------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[ri(rng, arr.length)];
const chance = (rng, p) => rng() < p;

// --- hostile-but-plausible parameter generators ---------------------------
const agentIdValid = a => typeof a === "string" && a.length >= 1 && a.length <= 128;

const genNote = rng => {
  const r = rng();
  if (r < 0.10) return undefined;
  if (r < 0.20) return "x".repeat(4001 + ri(rng, 500)); // hostile: over the 4000 bound
  if (r < 0.25) return 42;                              // hostile: wrong type
  return `note-${ri(rng, 100000)}`;
};

const genLeaseHours = rng => {
  const r = rng();
  if (r < 0.55) return undefined;
  if (r < 0.68) return null;                            // explicit lease opt-out
  if (r < 0.85) return pick(rng, [1, 2, 12, 24, 0.5, 168]);
  return pick(rng, [0, -1, 200, NaN, "24", Infinity]);  // hostile
};
const leaseOk = v => v === undefined || v === null ||
  (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 168);

const TAG_RE = /^[A-Za-z0-9_-]{1,32}$/;
const genTags = rng => {
  const r = rng();
  if (r < 0.15) return undefined;
  if (r < 0.70) return Array.from({ length: ri(rng, 4) }, () => `tag-${ri(rng, 50)}`);
  if (r < 0.80) return ["bad tag!", "ok"];                       // hostile: pattern
  if (r < 0.90) return Array.from({ length: 11 }, (_, i) => `t${i}`); // hostile: too many
  return "not-an-array";                                         // hostile: wrong type
};
const tagsValid = v => v === undefined || v === null ||
  (Array.isArray(v) && v.length <= 10 && v.every(t => typeof t === "string" && TAG_RE.test(t)));

const BLOB_RE = /^sha256:[0-9a-f]{64}$/;
const genBlobs = rng => {
  const r = rng();
  if (r < 0.15) return undefined;
  if (r < 0.70) return ri(rng, 3) === 0 ? [] : [`sha256:${"ab".repeat(32)}`];
  if (r < 0.85) return ["sha256:xyz"];                                  // hostile
  return Array.from({ length: 11 }, () => `sha256:${"cd".repeat(32)}`);  // hostile: too many
};
const blobsValid = v => v === undefined || v === null ||
  (Array.isArray(v) && v.length <= 10 && v.every(b => typeof b === "string" && BLOB_RE.test(b)));

const genDelta = rng => {
  const r = rng();
  if (r < 0.60) return ri(rng, 3600_000);                 // 0..1h
  if (r < 0.85) return 3600_000 + ri(rng, 3 * 86400_000); // 1h..~3d
  return 3 * 86400_000 + ri(rng, 30 * 86400_000);        // 3..33d — drives lease expiry
};

const OP_KINDS = ["claim", "claim", "renew", "update", "update", "update",
  "reassign", "attest", "attest", "close", "close", "releaseExpired"];

// --- op generation (with a conservative legality oracle) -------------------
// expectLegal=true means: by the module's own documented rules this op MUST
// succeed. It is deliberately conservative — a false "legal" must never
// happen; "illegal but accepted" is not flagged (permissive by design).
function genOp(rng, agents, nWorks, works, now) {
  const kind = pick(rng, OP_KINDS);
  const workIdx = ri(rng, nWorks);
  const before = works[workIdx];
  const agent = chance(rng, 0.12) ? pick(rng, ["intruder", "", 42, null]) : pick(rng, agents);
  const p = {};
  let expectLegal = false;
  const active = wc.ACTIVE_CLAIM_STATES.includes(before.state);
  const terminal = wc.isTerminalClaimState(before.state);
  const noteOk = v => v === undefined || (typeof v === "string" && v.length <= 4000);
  switch (kind) {
    case "claim": {
      p.note = genNote(rng);
      p.leaseHours = genLeaseHours(rng);
      expectLegal = before.state === "unclaimed" && agentIdValid(agent) &&
        noteOk(p.note) && leaseOk(p.leaseHours);
      break;
    }
    case "renew": {
      p.note = genNote(rng);
      p.leaseHours = genLeaseHours(rng);
      expectLegal = active && before.owner === agent && before.leaseExpiresAt !== null &&
        Date.parse(before.leaseExpiresAt) > now && noteOk(p.note) && leaseOk(p.leaseHours);
      break;
    }
    case "update": {
      const r = rng();
      if (r < 0.60) p.state = pick(rng, wc.STATES);
      else if (r < 0.72) p.state = pick(rng, ["bogus", "complete", "failed", "cancelled", ""]);
      else if (r < 0.80) p.state = null;   // hostile: explicit null
      else p.state = undefined;            // note-only update
      const wantDone = p.state === "done";
      const withExtras = wantDone || chance(rng, 0.12);
      p.deliveryMode = withExtras ? pick(rng, [...wc.DELIVERY_MODES, "bogus", null, undefined]) : undefined;
      p.reviewedBy = withExtras ? pick(rng, [...agents, "intruder", "", undefined]) : undefined;
      p.tags = withExtras ? genTags(rng) : undefined;
      p.blobs = withExtras ? genBlobs(rng) : undefined;
      p.authority = chance(rng, 0.20);
      p.note = genNote(rng);
      const callerOk = agentIdValid(agent) && (p.authority === true || before.owner === agent);
      const extrasAbsent = p.deliveryMode == null && p.reviewedBy == null && p.tags == null && p.blobs == null;
      if (!terminal && callerOk && noteOk(p.note)) {
        if (p.state === undefined) {
          expectLegal = active && extrasAbsent;
        } else {
          const allowed = wc.TRANSITIONS[before.state] ?? [];
          const extrasOk = wantDone
            ? (p.deliveryMode === undefined || p.deliveryMode === null || wc.DELIVERY_MODES.includes(p.deliveryMode)) &&
              (p.reviewedBy === undefined || p.reviewedBy === null || agentIdValid(p.reviewedBy)) &&
              tagsValid(p.tags) && blobsValid(p.blobs)
            : extrasAbsent;
          expectLegal = allowed.includes(p.state) && extrasOk;
        }
      }
      break;
    }
    case "reassign": {
      p.newOwner = chance(rng, 0.10) ? pick(rng, ["", 42, null]) : pick(rng, agents.concat(["intruder"]));
      p.note = genNote(rng);
      p.authority = chance(rng, 0.25);
      expectLegal = !terminal && agentIdValid(agent) &&
        (p.authority === true || before.owner === agent) &&
        agentIdValid(p.newOwner) && noteOk(p.note);
      break;
    }
    case "attest": {
      p.note = chance(rng, 0.15)
        ? "y".repeat(513 + ri(rng, 200))   // hostile: over the 512 bound
        : (chance(rng, 0.10) ? undefined : `a-${ri(rng, 5000)}`);
      expectLegal = active && agentIdValid(agent) &&
        (p.note === undefined || (typeof p.note === "string" && p.note.length <= 512));
      break;
    }
    case "close": {
      p.verb = chance(rng, 0.85) ? pick(rng, ["close", "cancel"]) : pick(rng, ["retire", "", null]);
      if (chance(rng, 0.05)) p.verb = undefined; // default verb ("close") path
      p.reason = chance(rng, 0.10) ? "z".repeat(4001 + ri(rng, 200))
        : (chance(rng, 0.2) ? undefined : `reason-${ri(rng, 100)}`);
      p.authority = chance(rng, 0.30);
      const verbEff = p.verb === undefined ? "close" : p.verb;
      const next = wc.nextClaimState(before.state, verbEff);
      const holder = before.owner !== null && before.owner === agent;
      const opener = before.state === "unclaimed" && before.owner === null && wc.creatorOf(before) === agent;
      expectLegal = next !== null && agentIdValid(agent) &&
        (p.authority === true || holder || (verbEff === "cancel" && opener)) &&
        (p.reason === undefined || p.reason === null ||
          (typeof p.reason === "string" && p.reason.length <= 4000));
      break;
    }
    case "releaseExpired": {
      expectLegal = true; // sweep never throws on well-formed items
      break;
    }
  }
  return { kind, workIdx, agent, p, expectLegal };
}

function applyOp(op, works, now) {
  const w = works[op.workIdx];
  const p = op.p;
  switch (op.kind) {
    case "claim":
      return { one: wc.claimWork(w, op.agent, { note: p.note, leaseHours: p.leaseHours, now }) };
    case "renew":
      return { one: wc.renewWork(w, op.agent, { note: p.note, leaseHours: p.leaseHours, now }) };
    case "update":
      return { one: wc.updateWork(w, op.agent, { state: p.state, note: p.note, deliveryMode: p.deliveryMode,
        reviewedBy: p.reviewedBy, tags: p.tags, blobs: p.blobs, authority: p.authority, now }) };
    case "reassign":
      return { one: wc.reassignWork(w, op.agent, p.newOwner, { note: p.note, authority: p.authority, now }) };
    case "attest":
      return { one: wc.attestWork(w, op.agent, { note: p.note, now }) };
    case "close":
      return { one: wc.closeWork(w, op.agent, { verb: p.verb, reason: p.reason, authority: p.authority, now }) };
    case "releaseExpired":
      return { all: wc.releaseExpired(works, now) };
    default:
      throw new Error(`unknown op ${op.kind}`);
  }
}

// attestWork's SEC-2 in-place note replace: same history length, only the
// caller's attestation entry changes (same memberId, same at/basis).
function attestReplaceOnly(b, n, agent) {
  const strip = w => { const copy = { ...w }; delete copy.attestations; return copy; };
  if (JSON.stringify(strip(b)) !== JSON.stringify(strip(n))) return false;
  const ba = b.attestations, na = n.attestations;
  if (ba.length !== na.length) return false;
  for (let i = 0; i < ba.length; i++) {
    const x = ba[i], y = na[i];
    if (x.memberId === agent) {
      if (y.memberId !== agent || y.at !== x.at) return false;
    } else if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

function checkOne(op, b, n, idx, claimedAtMs, pushV) {
  // (a) at most one current owner
  if (!(n.owner === null || typeof n.owner === "string")) {
    pushV("A-owner", `owner has type ${typeof n.owner}`);
  }
  // (b) claimedAt never moves backward, never cleared once set
  const prev = claimedAtMs[idx];
  if (n.claimedAt === null) {
    if (prev !== null) pushV("B-claimedAt-cleared", `claimedAt cleared (was ${prev})`);
  } else {
    const ms = Date.parse(n.claimedAt);
    if (!Number.isFinite(ms)) pushV("B-claimedAt-invalid", `claimedAt=${n.claimedAt}`);
    else {
      if (prev !== null && ms < prev) pushV("B-claimedAt-backward", `${prev} -> ${ms}`);
      claimedAtMs[idx] = ms;
    }
  }
  // (c) history append-only
  const oh = b.history, nh = n.history;
  const d = nh.length - oh.length;
  const dc = wc.claimHistoryLength(n) - wc.claimHistoryLength(b);
  if (d < 0 || d > 1) pushV("C-history-length", `history length delta ${d}`);
  else if (dc !== d) pushV("C-history-count", `length delta ${d} but claimHistoryLength delta ${dc}`);
  else if (d === 1) {
    for (let k = 0; k < oh.length; k++) {
      if (JSON.stringify(nh[k]) !== JSON.stringify(oh[k])) { pushV("C-history-prefix", `entry ${k} changed`); break; }
    }
    const ne = nh[nh.length - 1];
    const lo = oh[oh.length - 1];
    if (lo && ne.at < lo.at) pushV("C-history-time", `new stamp ${ne.at} older than ${lo.at}`);
    if (typeof ne.at !== "string" || typeof ne.action !== "string" || typeof ne.agentId !== "string") {
      pushV("C-history-shape", `bad stamp ${JSON.stringify(ne).slice(0, 120)}`);
    }
  } else if (JSON.stringify(nh) !== JSON.stringify(oh)) {
    if (!(op.kind === "attest" && attestReplaceOnly(b, n, op.agent))) {
      pushV("C-history-mutated", "history changed without an appended stamp");
    }
  }
}

// --- driver ---------------------------------------------------------------
const shortVal = v => {
  if (typeof v === "string" && v.length > 60) return `<str len=${v.length}>`;
  if (Array.isArray(v)) return v.map(shortVal);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortVal(x)]));
  }
  return v;
};

function stepOp(seq, step, op, works, claimedAtMs, now, violations, seen, stats) {
  const pushV = (invariant, detail) => {
    const sig = `${invariant} :: ${detail.replace(/[0-9a-f]{8,}/g, "#").replace(/\d+/g, "#")}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    if (violations.length < MAX_VIOLATIONS) {
      violations.push({ seq, step, seed: SEED, invariant, detail, now,
        op: { kind: op.kind, workIdx: op.workIdx, agent: shortVal(op.agent),
          params: shortVal(op.p), expectLegal: op.expectLegal } });
    }
  };
  const wi = op.workIdx;
  const sweep = op.kind === "releaseExpired";
  const before = sweep ? works.slice() : works[wi];
  const beforeSnap = JSON.stringify(before);
  let out;
  try {
    out = applyOp(op, works, now);
  } catch (e) {
    if (e instanceof wc.ClaimError) {
      // (e) rejected ops must leave the input byte-identical
      const target = sweep ? works : works[wi];
      if (JSON.stringify(target) !== beforeSnap) {
        pushV("E-reject-mutated", `rejected op mutated its input (code=${e.code})`);
      } else if (op.expectLegal) {
        // (f) oracle: a legal op must not be rejected
        pushV("L-legal-rejected", `legal op rejected: code=${e.code} msg=${e.message}`);
      } else {
        stats.rejected++;
      }
      return;
    }
    pushV("X-unexpected-throw", String((e && e.stack) || e));
    return;
  }
  // purity: successful ops must not mutate their input either
  const target = sweep ? works : works[wi];
  if (JSON.stringify(target) !== beforeSnap) {
    pushV("P-input-mutated", "successful op mutated its input");
  }
  if (sweep) {
    const arr = out.all;
    for (let i = 0; i < arr.length; i++) {
      const b = works[i], n = arr[i];
      if (wc.isTerminalClaimState(b.state)) {
        // (d) releaseExpired must pass terminal items through untouched
        if (n.state !== b.state || n.owner !== b.owner || n.claimedAt !== b.claimedAt ||
            n.history.length !== b.history.length) {
          pushV("D-terminal-changed", `releaseExpired altered terminal work ${b.id}: ${b.state}->${n.state}`);
        }
      } else {
        checkOne(op, b, n, i, claimedAtMs, pushV);
      }
      works[i] = n;
      if (n.claimedAt !== null) claimedAtMs[i] = Date.parse(n.claimedAt);
    }
    stats.applied++;
    return;
  }
  const b = works[wi];
  const nw = out.one;
  if (wc.isTerminalClaimState(b.state)) {
    // (d) terminal states are sinks — no legal op revives them
    pushV("D-terminal-revived", `op ${op.kind} succeeded on terminal work (state=${b.state})`);
  } else {
    checkOne(op, b, nw, wi, claimedAtMs, pushV);
  }
  works[wi] = nw;
  if (nw.claimedAt !== null) claimedAtMs[wi] = Date.parse(nw.claimedAt);
  stats.applied++;
}

function runSequence(seq, violations, seen, stats) {
  const rng = mulberry32((Math.imul(SEED | 0, 2654435761) ^ Math.imul(seq + 1, 40503)) >>> 0);
  const nWorks = 1 + ri(rng, 3);
  const nAgents = 2 + ri(rng, 3);
  const agents = Array.from({ length: nAgents }, (_, i) => `agent-${i}`);
  let now = BASE_NOW + ri(rng, 1_000_000);
  const works = [];
  const claimedAtMs = [];
  for (let i = 0; i < nWorks; i++) {
    now += ri(rng, 5000);
    works.push(wc.createWork({ id: `fz${seq}w${i}`, title: `fuzz ${seq}/${i}` },
      { now, agentId: agents[0] }));
    claimedAtMs.push(null);
  }
  const nOps = 5 + ri(rng, 46);
  for (let step = 0; step < nOps; step++) {
    now += genDelta(rng); // now only ever advances
    const op = genOp(rng, agents, nWorks, works, now);
    stats.ops++;
    stepOp(seq, step, op, works, claimedAtMs, now, violations, seen, stats);
  }
  stats.sequences++;
}

test("fuzz-01: claim state-machine op-sequence fuzz", { timeout: 30 * 60 * 1000 }, async () => {
  const violations = [];
  const seen = new Set();
  const stats = { sequences: 0, ops: 0, applied: 0, rejected: 0 };
  const t0 = Date.now();
  for (let seq = 0; seq < N_SEQUENCES; seq++) {
    runSequence(seq, violations, seen, stats);
    if ((seq + 1) % 2000 === 0) {
      console.log(`[fuzz-01] ${seq + 1}/${N_SEQUENCES} sequences, ops=${stats.ops}, ` +
        `violations=${violations.length}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[fuzz-01] done: sequences=${stats.sequences} ops=${stats.ops} ` +
    `applied=${stats.applied} rejected=${stats.rejected} violations=${violations.length} in ${secs}s`);
  if (process.env.FUZZ_DUMP && violations.length > 0) {
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.FUZZ_DUMP, JSON.stringify(violations, null, 2));
    console.log(`[fuzz-01] violations dumped to ${process.env.FUZZ_DUMP}`);
  }
  assert.equal(violations.length, 0,
    `invariant violations:\n${JSON.stringify(violations, null, 2).slice(0, 20000)}`);
});
