// WAVE-400 fuzz worker: bounty/settlement idempotency under retry.
//
// Target: the idempotency-key mechanism in server/bounty-escrow.mjs
// (BountyEscrow.idemExecute) as exercised by settle (bounty.accept) and
// refund (bounty.reject) ops. Complements (does not duplicate):
//   - tests/bounty-idempotency-scope.test.js  (scope isolation, cross-member leak #1000)
//   - tests/bounty-mcp-idempotency.test.js    (MCP dispatch-level replay)
//
// Attacks in this file:
//   A. same key replayed 20x sequentially for settle (accept) and refund (reject)
//   B. concurrent retry storm (4 processes x 8 attempts, shared file DB)
//   C. same key reused across DIFFERENT ops (settle key used for refund)
//   D. same key reused on a different bounty (same caller, same route)
//   E. same key + same scope with mutated payload (must 409, never re-execute)
//   F. hostile keys (empty, oversized, unicode, NUL, whitespace, non-strings, null)
//   G. retry after simulated mid-op failure (thunk throws after mutating)
//   H. replay purity when a failed op interleaves between replays
//
// Invariants: same key + same op => exactly-once effect (balance delta applied
// once, N replays change nothing, all replay bodies identical); same key +
// different op => never applied as the wrong op (route is part of the scope, so
// a cross-op key executes its OWN op, never replays the other op's body);
// mid-op failure => no idempotency record, full rollback, retry executes fresh.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

// Hand-rolled mulberry32 seeded RNG.
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-19] FUZZ_SEED=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = arr => arr[Math.floor(rng() * arr.length)];

const ROOM = "room-fuzz19";
const POSTER = "id:agent/jill";    // posts, funds, accepts, rejects
const WORKERS = ["id:agent/grokbot", "id:agent/instinct", "id:agent/codex"]; // claimants (genesis-funded)
const nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

// Every idemExecute call with a previously-seen key in the same scope is one
// replay attack. Counted so the report can state the attack volume.
let ATTACKS = 0;
const replayAttack = () => { ATTACKS += 1; };

function makeEscrow(dbPath = ":memory:") {
  const db = new DatabaseSync(dbPath);
  const transaction = fn => {
    db.exec("SAVEPOINT fuzz19");
    try { const out = fn(); db.exec("RELEASE fuzz19"); return out; }
    catch (error) { db.exec("ROLLBACK TO fuzz19"); db.exec("RELEASE fuzz19"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

// Drive one bounty to "submitted". Poster locks `amount` credits; worker
// posts the 1-credit claim bond and submits evidence.
function submittedBounty(escrow, worker, amount) {
  const { bounty } = escrow.postBounty(ROOM, { poster: POSTER, title: "F", criteria: "C",
    amount, deadline: isoFuture(3_600_000) });
  const bountyId = bounty.bountyId;
  escrow.fundBounty(ROOM, bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bountyId, { claimant: worker });
  escrow.submitWork(ROOM, bountyId, { claimant: worker,
    evidence: { evidenceUrl: "https://example.com/work", summary: "done" } });
  return bountyId;
}

const journalKindCount = (db, bountyId, kind) =>
  db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind=?")
    .get(ROOM, bountyId, kind).n;

const idemRows = (db, key) =>
  db.prepare("SELECT COUNT(*) AS n FROM bounty_idempotency WHERE room_id=? AND idem_key=? AND version=2")
    .get(ROOM, key).n;

const attFor = n => ({ note: "verified ok", round: n,
  citations: [{ criterionId: "c1", verdict: "pass" }] }); // default rubric pins criterion c1

// ---------------------------------------------------------------------------
// A. Sequential replay storms: same key 20x for settle and refund.
// ---------------------------------------------------------------------------

test("A1: settle (accept) with the same idempotency key replayed 20x applies exactly once", t => {
  const ROUNDS = 250, REPLAYS = 20;
  let executed = 0;
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 30 === 0) { var fx = makeEscrow(); } // fresh room: poster budget 100 credits
    const { escrow, db } = fx;
    const amount = 1 + Math.floor(rng() * 3); // 1..3 credits, stays under poster budget
    const worker = pick(WORKERS);
    const bountyId = submittedBounty(escrow, worker, amount);
    const key = `settle-${SEED}-${round}`;
    const att = attFor(round);
    const scope = () => ({ callerLane: POSTER, bountyId, payload: { verifierAttestation: att } });
    const thunk = () => { executed += 1;
      return escrow.acceptWork(ROOM, bountyId, { acceptor: POSTER, verifierAttestation: att }); };
    const before = escrow.balances(ROOM, worker);
    const bodies = [];
    for (let i = 0; i < REPLAYS; i++) {
      const r = escrow.idemExecute(ROOM, key, "bounty.accept", 200, thunk, scope());
      replayAttack();
      assert.equal(r.replayed, i > 0, `round ${round} replay ${i}: replayed flag`);
      bodies.push(r.body);
    }
    assert.equal(executed, round + 1, `round ${round}: one cumulative execution`);
    const after = escrow.balances(ROOM, worker);
    assert.equal(after.attributed - before.attributed, amount,
      `round ${round}: worker attributed delta must be exactly the award, once`);
    assert.equal(journalKindCount(db, bountyId, "attribute"), 2,
      `round ${round}: exactly one attribute journal row`);
    for (let i = 1; i < REPLAYS; i++)
      assert.deepEqual(bodies[i], bodies[0], `round ${round}: replay body ${i} identical`);
    assert.equal(idemRows(db, key), 1, `round ${round}: one idempotency record`);
  }
  assert.equal(executed, ROUNDS, "exactly one execution per round across all rounds");
  t.diagnostic(`A1 done: ${ROUNDS * REPLAYS} settle replay attacks, executed=${executed}`);
});

test("A2: refund (reject) with the same idempotency key replayed 20x applies exactly once", t => {
  const ROUNDS = 60, REPLAYS = 20; // reject strikes the claimant: rotate workers, fresh room often
  let executed = 0;
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 6 === 0) { var fx = makeEscrow(); } // <=2 strikes per worker: no cooldown
    const { escrow, db } = fx;
    const amount = 1 + Math.floor(rng() * 3);
    const worker = WORKERS[round % WORKERS.length];
    const bountyId = submittedBounty(escrow, worker, amount);
    const key = `refund-${SEED}-${round}`;
    const reason = `verification failed round ${round}`;
    const scope = () => ({ callerLane: POSTER, bountyId, payload: { reason } });
    const thunk = () => { executed += 1;
      return escrow.rejectWork(ROOM, bountyId, { rejector: POSTER, reason }); };
    const pBefore = escrow.balances(ROOM, POSTER);
    const bodies = [];
    for (let i = 0; i < REPLAYS; i++) {
      const r = escrow.idemExecute(ROOM, key, "bounty.reject", 200, thunk, scope());
      replayAttack();
      assert.equal(r.replayed, i > 0, `round ${round} replay ${i}: replayed flag`);
      bodies.push(r.body);
    }
    const pAfter = escrow.balances(ROOM, POSTER);
    assert.equal(pBefore.locked - pAfter.locked, amount,
      `round ${round}: poster locked decreases by exactly the award, once`);
    assert.equal(pAfter.payable - pBefore.payable, amount,
      `round ${round}: poster payable increases by exactly the award, once`);
    assert.equal(escrow.getBounty(ROOM, bountyId).state, "refunded");
    assert.equal(journalKindCount(db, bountyId, "refund"), 2,
      `round ${round}: exactly one refund journal row`);
    assert.equal(journalKindCount(db, bountyId, "attribute"), 0,
      `round ${round}: no attribute row on a refunded bounty`);
    for (let i = 1; i < REPLAYS; i++)
      assert.deepEqual(bodies[i], bodies[0], `round ${round}: replay body ${i} identical`);
  }
  assert.equal(executed, ROUNDS, "exactly one execution per round across all rounds");
  t.diagnostic(`A2 done: ${ROUNDS * REPLAYS} refund replay attacks, executed=${executed}`);
});

// ---------------------------------------------------------------------------
// B. Concurrent retry storm: 4 processes x 8 attempts on one key.
// ---------------------------------------------------------------------------

const CHILD_SRC = `
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from ${JSON.stringify(join(process.cwd(), "server/bounty-escrow.mjs"))};
const db = new DatabaseSync(process.env.FUZZ_DB);
const tx = fn => {
  db.exec("SAVEPOINT conc");
  try { const o = fn(); db.exec("RELEASE conc"); return o; }
  catch (e) { db.exec("ROLLBACK TO conc"); db.exec("RELEASE conc"); throw e; }
};
const escrow = new BountyEscrow({ db, transaction: tx, readTransaction: tx },
  { now: () => ${nowMs}, allowLegacyStringLanes: true });
const out = [];
for (let i = 0; i < 8; i++) {
  try {
    const r = escrow.idemExecute(process.env.FUZZ_ROOM, process.env.FUZZ_KEY, "bounty.accept", 200,
      () => escrow.acceptWork(process.env.FUZZ_ROOM, process.env.FUZZ_BOUNTY,
        { acceptor: "id:agent/jill", verifierAttestation: { note: "conc",
          citations: [{ criterionId: "c1", verdict: "pass" }] } }),
      { callerLane: "id:agent/jill", bountyId: process.env.FUZZ_BOUNTY,
        payload: { verifierAttestation: { note: "conc",
          citations: [{ criterionId: "c1", verdict: "pass" }] } } });
    out.push(r.replayed ? "replayed" : "executed");
  } catch (e) { out.push("error:" + (e.code || e.name || "unknown")); }
}
db.close();
console.log(JSON.stringify(out));
`;

test("B: concurrent retry storm on one settle key keeps exactly-once effect", async t => {
  const dir = process.env.TMPDIR || tmpdir();
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, `fuzz19-conc-${process.pid}.db`);
  const { escrow, db } = makeEscrow(dbPath);
  const amount = 5;
  const bountyId = submittedBounty(escrow, WORKERS[0], amount);
  const wBefore = escrow.balances(ROOM, WORKERS[0]);
  const key = `conc-settle-${SEED}`;
  db.close(); // release the file so the children can open it

  const runChild = () => new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", CHILD_SRC], {
      cwd: join(process.cwd()), timeout: 60_000,
      env: { ...process.env, FUZZ_DB: dbPath, FUZZ_ROOM: ROOM, FUZZ_KEY: key, FUZZ_BOUNTY: bountyId },
    }, (err, stdout, stderr) => err ? reject(new Error(`child failed: ${err.message} ${stderr}`))
      : resolve(JSON.parse(stdout)));
  });
  const results = await Promise.all([runChild(), runChild(), runChild(), runChild()]);
  const flat = results.flat();
  const tally = {};
  for (const o of flat) { tally[o] = (tally[o] ?? 0) + 1; replayAttack(); }

  const reopen = makeEscrow(dbPath);
  try {
    const wAfter = reopen.escrow.balances(ROOM, WORKERS[0]);
    assert.equal(wAfter.attributed - wBefore.attributed, amount,
      `concurrent storm: worker attributed delta must be exactly the award once (got ${wAfter.attributed - wBefore.attributed}, want ${amount})`);
    assert.equal(journalKindCount(reopen.db, bountyId, "attribute"), 2,
      "concurrent storm: exactly one attribute journal row");
    assert.equal(reopen.escrow.getBounty(ROOM, bountyId).state, "accepted");
    t.diagnostic(`B done: 32 concurrent attempts, outcomes=${JSON.stringify(tally)}`);
    const errors = flat.filter(o => o.startsWith("error:"));
    if (errors.length > 0)
      t.diagnostic(`B note: ${errors.length} attempts errored instead of replaying: ${JSON.stringify([...new Set(errors)])}`);
  } finally {
    reopen.db.close();
  }
});

// ---------------------------------------------------------------------------
// C. Same key reused across DIFFERENT ops: never applied as the wrong op.
// ---------------------------------------------------------------------------

test("C1: a settle key reused for a refund executes its own op, never the settle body", t => {
  const ROUNDS = 200;
  for (let round = 0; round < ROUNDS; round++) {
    // Reject strikes the claimant (cooldown at 3 strikes): rotate workers so
    // each takes <=2 strikes per room, fresh room every 6 rounds.
    if (round % 6 === 0) { var fx = makeEscrow(); }
    const { escrow, db } = fx;
    const amount = 1 + Math.floor(rng() * 2);
    const wA = WORKERS[round % WORKERS.length], wB = WORKERS[(round + 1) % WORKERS.length];
    const wbBefore = escrow.balances(ROOM, wB).attributed;
    const aId = submittedBounty(escrow, wA, amount);
    const bId = submittedBounty(escrow, wB, amount);
    const key = `xop-${SEED}-${round}`;
    const att = attFor(round), reason = `xop reject ${round}`;

    const settle = escrow.idemExecute(ROOM, key, "bounty.accept", 200,
      () => escrow.acceptWork(ROOM, aId, { acceptor: POSTER, verifierAttestation: att }),
      { callerLane: POSTER, bountyId: aId, payload: { verifierAttestation: att } });
    assert.equal(settle.replayed, false);

    // Same key, different op (route is part of the scope): must execute the
    // refund as its own op — never replay the settle body, never settle B.
    const refund = escrow.idemExecute(ROOM, key, "bounty.reject", 200,
      () => escrow.rejectWork(ROOM, bId, { rejector: POSTER, reason }),
      { callerLane: POSTER, bountyId: bId, payload: { reason } });
    replayAttack(); replayAttack();
    assert.equal(refund.replayed, false, `round ${round}: cross-op key must execute its own op`);
    assert.equal(refund.body.receipt.kind, "reject", `round ${round}: refund body is a reject receipt`);
    assert.equal(refund.body.bounty.bountyId, bId);
    assert.equal(escrow.getBounty(ROOM, aId).state, "accepted");
    assert.equal(escrow.getBounty(ROOM, bId).state, "refunded");
    assert.equal(journalKindCount(db, aId, "attribute"), 2);
    assert.equal(journalKindCount(db, aId, "refund"), 0, `round ${round}: settle key never refunded A`);
    assert.equal(journalKindCount(db, bId, "refund"), 2);
    assert.equal(journalKindCount(db, bId, "attribute"), 0, `round ${round}: refund never settled B`);
    const wb = escrow.balances(ROOM, wB);
    assert.equal(wb.attributed - wbBefore, 0, `round ${round}: B's worker attributed nothing`);
  }
  t.diagnostic(`C1 done: ${ROUNDS * 2} cross-op attacks, zero cross-op applications`);
});

test("C2: same key + same route + same caller on a DIFFERENT bounty executes (bounty is in scope)", t => {
  const ROUNDS = 100;
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 20 === 0) { var fx = makeEscrow(); }
    const { escrow } = fx;
    const key = `difb-${SEED}-${round}`;
    const mk = () => { const { bounty } = escrow.postBounty(ROOM, { poster: POSTER, title: "F", criteria: "C",
      amount: 1, deadline: isoFuture(3_600_000) }); return bounty.bountyId; };
    const aId = mk(), bId = mk();
    const fund = (bountyId, funder) => escrow.idemExecute(ROOM, key, "bounty.fund", 200,
      () => escrow.fundBounty(ROOM, bountyId, { funder }), { callerLane: POSTER, bountyId });
    const ra = fund(aId, POSTER);
    assert.equal(ra.replayed, false);
    const rb = fund(bId, POSTER);
    replayAttack(); replayAttack();
    assert.equal(rb.replayed, false, `round ${round}: different bounty must not replay A's fund`);
    assert.equal(escrow.getBounty(ROOM, aId).state, "funded");
    assert.equal(escrow.getBounty(ROOM, bId).state, "funded");
  }
  t.diagnostic(`C2 done: ${ROUNDS * 2} same-key/different-bounty attacks`);
});

// ---------------------------------------------------------------------------
// D. Same key + same scope with mutated payload: 409, never re-executed.
// ---------------------------------------------------------------------------

test("D: replaying a key with a changed payload is rejected without re-execution", t => {
  const ROUNDS = 200;
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 20 === 0) { var fx = makeEscrow(); }
    const { escrow, db } = fx;
    const amount = 1 + Math.floor(rng() * 2);
    const worker = pick(WORKERS);
    const bountyId = submittedBounty(escrow, worker, amount);
    const key = `mut-${SEED}-${round}`;
    let executed = 0;
    const att1 = attFor(round);
    const first = escrow.idemExecute(ROOM, key, "bounty.accept", 200,
      () => { executed += 1; return escrow.acceptWork(ROOM, bountyId, { acceptor: POSTER, verifierAttestation: att1 }); },
      { callerLane: POSTER, bountyId, payload: { verifierAttestation: att1 } });
    assert.equal(first.replayed, false);

    // Mutated payloads: extra field, changed field, dropped field, reordered (reorder is OK).
    const mutations = [
      { verifierAttestation: { ...att1, extra: rng() } },
      { verifierAttestation: { note: "tampered", r: round } },
      { verifierAttestation: { r: round } },
    ];
    for (const payload of mutations) {
      assert.throws(() => escrow.idemExecute(ROOM, key, "bounty.accept", 200,
        () => { executed += 1; throw new Error("changed payload executed"); },
        { callerLane: POSTER, bountyId, payload }), { code: "idempotency_key_reused" },
        `round ${round}: mutated payload must be rejected`);
      replayAttack();
    }
    // Reordered fields are the same payload (canonical JSON): still replays.
    const reordered = escrow.idemExecute(ROOM, key, "bounty.accept", 200,
      () => { throw new Error("reordered payload executed"); },
      { callerLane: POSTER, bountyId, payload: { verifierAttestation:
        { citations: [{ verdict: "pass", criterionId: "c1" }], round, note: "verified ok" } } });
    replayAttack();
    assert.equal(reordered.replayed, true, `round ${round}: field reorder must still replay`);
    assert.equal(executed, 1, `round ${round}: exactly one execution`);
    assert.equal(journalKindCount(db, bountyId, "attribute"), 2);
  }
  t.diagnostic(`D done: ${ROUNDS * 4} payload-mutation attacks, all rejected-or-replayed`);
});

// ---------------------------------------------------------------------------
// E. Hostile keys.
// ---------------------------------------------------------------------------

test("E: hostile idempotency keys are validated without crashing or corrupting state", t => {
  const { escrow, db } = makeEscrow();
  const uni = n => Array.from({ length: n }, () => String.fromCodePoint(0x1f600 + Math.floor(rng() * 80))).join("");
  const keys = [
    { key: "", ok: false },                                    // empty
    { key: "x".repeat(129), ok: false },                      // 1 over the limit
    { key: "x".repeat(10000), ok: false },                    // huge
    { key: "x".repeat(128), ok: true },                       // boundary: valid
    { key: "k", ok: true },                                   // boundary: valid
    { key: " ", ok: true },                                   // whitespace
    { key: "\n\t\r", ok: true },                            // control whitespace
    { key: "a\0b", ok: true },                                // NUL byte inside
    { key: "\0", ok: true },                                  // bare NUL
    { key: uni(10), ok: true },                               // emoji
    { key: "k" + "\u202e" + "x", ok: true },                  // RTL override
    { key: "k" + "\u0301".repeat(40), ok: true },             // combining marks
    { key: "key with spaces and/slashes?and=query&", ok: true },
    { key: 42, ok: false }, { key: {}, ok: false }, { key: [], ok: false }, { key: true, ok: false },
  ];
  // Plus 300 RNG-generated hostile keys: random lengths and alphabets.
  const alphabets = ["x", "🔑", "\0", " ", "é", "\u202e", "A"];
  for (let i = 0; i < 300; i++) {
    const len = [0, 1, 2, 64, 127, 128, 129, 200, 500][Math.floor(rng() * 9)];
    const alpha = pick(alphabets);
    const key = alpha.repeat(len);
    // Validity is by UTF-16 code units (String.length), matching the check.
    keys.push({ key, ok: key.length >= 1 && key.length <= 128 });
  }
  let n = 0;
  for (const { key, ok } of keys) {
    n += 1;
    const scope = { callerLane: POSTER, bountyId: `HK-${n}`, payload: { n } };
    if (!ok) {
      assert.throws(() => escrow.idemExecute(ROOM, key, "bounty.post", 201, () => ({ n }),
        scope), /idempotency key/, `hostile key ${JSON.stringify(String(key)).slice(0, 40)} must be rejected`);
      replayAttack();
      continue;
    }
    let executed = 0;
    const first = escrow.idemExecute(ROOM, key, "bounty.post", 201,
      () => { executed += 1; return { n }; }, scope);
    assert.equal(first.replayed, false, `valid hostile key ${n} must execute`);
    const second = escrow.idemExecute(ROOM, key, "bounty.post", 201,
      () => { executed += 1; throw new Error("hostile replay executed"); }, scope);
    replayAttack(); replayAttack();
    assert.equal(second.replayed, true, `valid hostile key ${n} must replay`);
    assert.equal(executed, 1, `valid hostile key ${n}: exactly one execution`);
  }
  t.diagnostic(`E done: ${keys.length} hostile-key attacks`);
});

test("E2: null/undefined keys bypass idempotency (documented) — every retry is a distinct op", t => {
  const { escrow } = makeEscrow();
  let n = 0;
  for (const key of [null, undefined, null, undefined, null]) {
    const r = escrow.idemExecute(ROOM, key, "bounty.post", 201, () => { n += 1; return { n }; },
      { callerLane: POSTER, bountyId: "NK", payload: { n } });
    assert.equal(r.replayed, false);
    replayAttack();
  }
  assert.equal(n, 5, "keyless calls are never deduplicated (documented behavior)");
  t.diagnostic("E2 done: 5 keyless attacks, all executed (documented bypass)");
});

// ---------------------------------------------------------------------------
// F. Retry after simulated mid-op failure: rollback, no record, fresh retry.
// ---------------------------------------------------------------------------

test("F1: a thunk that throws after mutating leaves no record and the retry executes fresh", t => {
  const ROUNDS = 250;
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 30 === 0) { var fx = makeEscrow(); }
    const { escrow, db } = fx;
    const amount = 1 + Math.floor(rng() * 2);
    const worker = pick(WORKERS);
    const bountyId = submittedBounty(escrow, worker, amount);
    const key = `midfail-${SEED}-${round}`;
    const att = attFor(round);
    const scope = { callerLane: POSTER, bountyId, payload: { verifierAttestation: att } };
    const wBefore = escrow.balances(ROOM, worker);

    // Attempt 1: the op runs (moves money, writes events) then the process
    // "crashes" before the idempotency record is written.
    assert.throws(() => escrow.idemExecute(ROOM, key, "bounty.accept", 200,
      () => { escrow.acceptWork(ROOM, bountyId, { acceptor: POSTER, verifierAttestation: att });
        throw new Error("simulated mid-op crash"); }, scope), /simulated mid-op crash/);
    replayAttack();
    assert.equal(idemRows(db, key), 0, `round ${round}: failed op must leave no idempotency record`);
    assert.equal(escrow.getBounty(ROOM, bountyId).state, "submitted",
      `round ${round}: failed op must roll back the bounty state`);
    assert.equal(journalKindCount(db, bountyId, "attribute"), 0,
      `round ${round}: failed op must roll back the journal`);
    assert.deepEqual(escrow.balances(ROOM, worker), wBefore,
      `round ${round}: failed op must roll back balances`);

    // Attempt 2: same key + same payload executes as a fresh op.
    let executed = 0;
    const retry = escrow.idemExecute(ROOM, key, "bounty.accept", 200,
      () => { executed += 1; return escrow.acceptWork(ROOM, bountyId, { acceptor: POSTER, verifierAttestation: att }); },
      scope);
    replayAttack();
    assert.equal(retry.replayed, false, `round ${round}: retry after failure must execute`);
    assert.equal(executed, 1);
    assert.equal(escrow.balances(ROOM, worker).attributed - wBefore.attributed, amount);
    assert.equal(journalKindCount(db, bountyId, "attribute"), 2);
  }
  t.diagnostic(`F1 done: ${ROUNDS * 2} mid-op-failure attacks, all rolled back and retried exactly once`);
});

test("F2: a business-logic failure does not poison the key — retry re-executes, fix succeeds", t => {
  const ROUNDS = 60;
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 20 === 0) { var fx = makeEscrow(); }
    const { escrow, db } = fx;
    const worker = pick(WORKERS);
    const bountyId = submittedBounty(escrow, worker, 1);
    const key = `bizfail-${SEED}-${round}`;
    const bad = {}, good = attFor(round);
    const attempt = payload => escrow.idemExecute(ROOM, key, "bounty.accept", 200,
      () => escrow.acceptWork(ROOM, bountyId, { acceptor: POSTER, verifierAttestation: payload }),
      { callerLane: POSTER, bountyId, payload: { verifierAttestation: payload } });
    // Attempt 1: invalid attestation — the op fails before any record.
    assert.throws(() => attempt(bad), { code: "invalid_input" });
    replayAttack();
    assert.equal(idemRows(db, key), 0, `round ${round}: business failure leaves no record`);
    // Attempt 2: same key + same (bad) payload re-executes and fails again —
    // the failure was NOT cached as a success.
    assert.throws(() => attempt(bad), { code: "invalid_input" });
    replayAttack();
    // Attempt 3: fixed payload executes exactly once.
    const ok = attempt(good);
    replayAttack();
    assert.equal(ok.replayed, false);
    assert.equal(journalKindCount(db, bountyId, "attribute"), 2);
  }
  t.diagnostic(`F2 done: ${ROUNDS * 3} business-failure attacks`);
});

// ---------------------------------------------------------------------------
// G. Replay purity: a failed op interleaved between replays changes nothing.
// ---------------------------------------------------------------------------

test("G: a failed op between replays does not disturb the replay or the ledger", t => {
  const ROUNDS = 100;
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 20 === 0) { var fx = makeEscrow(); }
    const { escrow, db } = fx;
    const amount = 1 + Math.floor(rng() * 2);
    const worker = pick(WORKERS);
    const bountyId = submittedBounty(escrow, worker, amount);
    const key = `pure-${SEED}-${round}`;
    const att = attFor(round);
    const scope = { callerLane: POSTER, bountyId, payload: { verifierAttestation: att } };
    const first = escrow.idemExecute(ROOM, key, "bounty.accept", 200,
      () => escrow.acceptWork(ROOM, bountyId, { acceptor: POSTER, verifierAttestation: att }), scope);
    assert.equal(first.replayed, false);
    const mid = escrow.balances(ROOM, worker);

    // An interleaved op that fails (bounty no longer submitted): keyless, so
    // it is not part of any idempotency record.
    assert.throws(() => escrow.rejectWork(ROOM, bountyId, { rejector: POSTER, reason: "too late" }),
      { code: "invalid_state" });

    for (let i = 0; i < 5; i++) {
      const r = escrow.idemExecute(ROOM, key, "bounty.accept", 200,
        () => { throw new Error("purity replay executed"); }, scope);
      replayAttack();
      assert.equal(r.replayed, true, `round ${round}: replay ${i} must short-circuit`);
      assert.deepEqual(r.body, first.body, `round ${round}: replay ${i} body identical`);
    }
    assert.deepEqual(escrow.balances(ROOM, worker), mid, `round ${round}: balances untouched`);
    assert.equal(journalKindCount(db, bountyId, "attribute"), 2);
    assert.equal(journalKindCount(db, bountyId, "refund"), 0);
  }
  t.diagnostic(`G done: ${ROUNDS * 5} purity attacks`);
});

test("Z: report", t => {
  console.log(`[fuzz-19] TOTAL_REPLAY_ATTACKS=${ATTACKS}`);
  assert.ok(ATTACKS >= 2000, `expected >=2000 replay attacks, got ${ATTACKS}`);
});
