// WAVE-400 fuzz worker: concurrent claim races (extends QA-200's 66 staged race rounds).
//
// TARGET: server/work-claims.mjs claimWork (pure) + the sqlite persistence path
// used by server/work-claim-routes.mjs. The real route path is, verbatim:
//
//   "Consume the body before opening SQLite's synchronous transaction. The read,
//    state transition and write then share one transaction"
//    (server/work-claim-routes.mjs:584-586, executed at :650 via
//    `registry.transaction(run)`), and production wires that transaction to
//    BEGIN IMMEDIATE (server/store.mjs:645-671, "Room transactions must remain
//    synchronous" — an await inside throws). So in the shipped path a claim
//    attempt is ONE synchronous transaction: load -> 409 pre-check -> lease /
//    cap gates -> claimWork -> file-lease check -> registry.set. The driver
//    below reproduces exactly that shape; the route-only gates it cannot import
//    (lease-choice, member cap, dependsOn-known, file-lease overlap) are
//    re-implemented with the route's real status codes (404/409/422).
//
// CAMPAIGNS
//   A1  pure claim race: N=2..16 distinct agents race one unclaimed item,
//       100 rounds per N (1500 rounds). Yields are injected BEFORE each attempt's
//       transaction to randomize arrival order. Invariants: exactly one winner,
//       losers get clean typed refusals (never a throw), final read-back has
//       exactly one "claimed" stamp naming the winner.
//   A2  claim+release+reclaim triples: 600 rounds of 3..8 mixed atomic ops
//       (claim/release/renew/start) from 2..4 agents with randomized order.
//       Invariants: no dirty throws; every op succeeds or refuses cleanly;
//       final read-back is a fully coherent item and its owner matches the
//       last ownership-changing history stamp.
//   A3  invalid-input races: 150 rounds, every agent sends an invalid option.
//       Invariants: zero winners, all clean 422s, item stays pristine.
//   B   ADVERSARIAL (not the shipped path): the registry's default no-op
//       transaction (fn => fn()) with yields injected BETWEEN the steps
//       (load -> yield -> pre-check -> yield -> claimWork -> yield -> set),
//       deliberately breaking the documented transaction boundary to confirm
//       it is load-bearing and to hunt for torn state. Double-wins here are
//       EXPECTED (last-writer-wins); the assertions are: no dirty throws and
//       the final row is never torn (whole-row JSON replace).
//
// DONE when: >=2000 race rounds across N=2..16 with zero double-wins / zero
// torn states on the real path (A), or a confirmed bug with repro.

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { createWork, claimWork, updateWork, renewWork } from "../server/work-claims.mjs";

// ---------------------------------------------------------------- RNG ----
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-02-claim-concurrent] seed=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const randInt = n => Math.floor(rng() * n);
const pick = arr => arr[randInt(arr.length)];

// -------------------------------------------------------------- yields ----
const tick = () => new Promise(res => process.nextTick(res));
const imm = () => new Promise(res => setImmediate(res));
// Random 0..maxGaps event-loop hops, mixing nextTick and setImmediate so
// competing attempts interleave in many orders.
async function jitter(maxGaps = 3) {
  const n = randInt(maxGaps + 1);
  for (let i = 0; i < n; i++) {
    if (rng() < 0.5) await tick(); else await imm();
  }
}

// ------------------------------------------------------- typed refusals ---
const typed = (status, code, message) => {
  const error = new Error(message);
  error.status = status; error.code = code;
  return error;
};
const isCleanRefusal = error => Number.isInteger(error?.status) && typeof error?.code === "string";
const asClean = fn => { try { return { ok: true, value: fn() }; } catch (error) {
  if (isCleanRefusal(error)) return { ok: false, status: error.status, code: error.code };
  return { ok: false, dirty: String((error && error.stack) || error).slice(0, 500) };
}; };
// Async variant: asClean only catches synchronous throws; an async attempt's
// rejection must be awaited or it escapes as an unhandledRejection.
const asCleanAsync = async fn => { try { return { ok: true, value: await fn() }; } catch (error) {
  if (isCleanRefusal(error)) return { ok: false, status: error.status, code: error.code };
  return { ok: false, dirty: String((error && error.stack) || error).slice(0, 500) };
}; };
const claimErrToRefusal = error => {
  if (error?.name === "ClaimError") throw typed(422, error.code, error.message);
  throw error;
};

// ------------------------------------------------------------------ db ----
const ROOM = "fuzz-claim-room";
const ROOM_OWNER = "fuzz-room-owner";
const ACTIVE = ["claimed", "in_progress", "blocked"];
const dir = join(dirname(fileURLToPath(import.meta.url)), ".tmp", `fuzz-02-${process.pid}`);
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, "race.db");
function openDb() {
  const db = new DatabaseSync(dbPath);
  // Production uses synchronous=FULL (server/store.mjs); the fuzz db uses
  // NORMAL for speed. The fsync policy changes durability timing only — the
  // BEGIN IMMEDIATE locking and atomic whole-row replace under test are
  // identical.
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  return db;
}
// Production write discipline (server/store.mjs:671): BEGIN IMMEDIATE.
function immediateTxn(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const out = fn(); db.exec("COMMIT"); return out; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
}
const db = openDb();
db.exec(workClaimSchema);
const registry = createDurableWorkClaimRegistry(db, { transaction: fn => immediateTxn(db, fn) });
// Campaign B: same file, second handle, default no-op transaction.
const dbB = openDb();
const registryB = createDurableWorkClaimRegistry(dbB);

// ------------------------------------------- route-faithful claim driver ---
// Mirrors handleWorkClaimsCore "claim": one synchronous transaction holding
// load -> pre-check -> gates -> claimWork -> file-lease check -> set.
//
// PERF: the route's cap/file-lease gates scan registry.list(roomId); with
// thousands of fuzz rows that scan dominates. The driver keeps the same
// semantics with targeted reads: per-agent open-claim counts in a JS map
// (claim +1 / release -1) and a direct get() of the one known live holder.
function routeClaim(reg, claimId, agent, opts, heldCounts) {
  return reg.transaction(() => {
    const item = reg.get(ROOM, claimId);
    if (!item) throw typed(404, "work_claim_not_found", `No work claim "${claimId}"`);
    if (item.state !== "unclaimed") throw typed(409, "work_claim_conflict", `Work "${claimId}" is already ${item.state}`);
    if (opts.leaseHours === null && agent !== ROOM_OWNER) {
      throw typed(422, "invalid_claim_input", "leaseHours null is only for the room owner");
    }
    if (Array.isArray(opts.dependsOn) && opts.dependsOn.some(d => !reg.has(ROOM, d))) {
      throw typed(422, "invalid_claim_input", "dependsOn names an unknown claim");
    }
    if ((heldCounts.get(agent) ?? 0) >= 20) throw typed(409, "too_many_open_claims", "member open-claim cap reached");
    let claimed;
    try {
      claimed = claimWork(item, agent, {
        note: opts.note, leaseHours: opts.leaseHours, files: opts.files,
        dependsOn: opts.dependsOn, evidenceRefs: opts.evidenceRefs, now: Date.now(),
      });
    } catch (error) { claimErrToRefusal(error); }
    // Exclusive file lease, checked after the pure claim but before commit,
    // inside the same transaction (route-faithful 409; rolls everything back).
    if (!opts.advisory && opts.holderId) {
      const holder = reg.get(ROOM, opts.holderId);
      if (holder && ACTIVE.includes(holder.state) && holder.owner && holder.owner !== agent &&
          claimed.files.some(f => (holder.files ?? []).includes(f))) {
        throw typed(409, "file_lease_conflict", "declared files overlap a live claim");
      }
    }
    reg.set(ROOM, claimed);
    heldCounts.set(agent, (heldCounts.get(agent) ?? 0) + 1);
    return claimed;
  });
}

function routeRelease(reg, claimId, agent, heldCounts) {
  return reg.transaction(() => {
    let item = reg.get(ROOM, claimId);
    if (!item) throw typed(404, "work_claim_not_found", `No work claim "${claimId}"`);
    if (item.owner !== agent) throw typed(422, "work_not_owner", `Work "${claimId}" is owned by ${item.owner ?? "nobody"}`);
    const wasActive = ACTIVE.includes(item.state);
    try {
      // W2 route shape: pause an active claim first, both steps stamped.
      if (item.state === "in_progress" || item.state === "blocked") {
        item = updateWork(item, agent, { state: "claimed", note: "paused for release", now: Date.now() });
        reg.set(ROOM, item);
      }
      const released = updateWork(item, agent, { state: "unclaimed", note: "fuzz release", now: Date.now() });
      reg.set(ROOM, released);
      if (wasActive && heldCounts) heldCounts.set(agent, Math.max(0, (heldCounts.get(agent) ?? 1) - 1));
      return released;
    } catch (error) { claimErrToRefusal(error); }
  });
}

function routeRenew(reg, claimId, agent) {
  return reg.transaction(() => {
    let renewed;
    try { renewed = renewWork(reg.get(ROOM, claimId), agent, { now: Date.now() }); }
    catch (error) { claimErrToRefusal(error); }
    reg.set(ROOM, renewed);
    return renewed;
  });
}

function routeStart(reg, claimId, agent) {
  return reg.transaction(() => {
    let next;
    try { next = updateWork(reg.get(ROOM, claimId), agent, { state: "in_progress", now: Date.now() }); }
    catch (error) { claimErrToRefusal(error); }
    reg.set(ROOM, next);
    return next;
  });
}

// ------------------------------------------------------------ read-back ---
function checkReadback(final, context) {
  const problems = [];
  // workOf is private to the state machine; validate the decoded row shape
  // directly (decodeItem in work-claim-sqlite.mjs mirrors workOf's fields).
  const item = final;
  const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done", "closed"];
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !STATES.includes(item.state)) {
    problems.push(`final row is not a work-claim shape: ${JSON.stringify(item).slice(0, 160)}`);
    return { item: null, problems };
  }
  if ((item.owner == null) !== (item.state === "unclaimed")) {
    problems.push(`owner/state incoherent: owner=${item.owner} state=${item.state}`);
  }
  if (item.owner != null) {
    if (typeof item.claimedAt !== "string" || !Number.isFinite(Date.parse(item.claimedAt))) {
      problems.push(`owner ${item.owner} but claimedAt=${item.claimedAt}`);
    }
    if (!["claimed", "in_progress", "blocked", "done"].includes(item.state)) {
      problems.push(`owner ${item.owner} but terminal-ish state ${item.state}`);
    }
  }
  const leaseSet = item.leaseStartAt != null || item.leaseExpiresAt != null;
  if (leaseSet && !(item.leaseStartAt && item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) > Date.parse(item.leaseStartAt))) {
    problems.push(`lease incoherent: start=${item.leaseStartAt} expires=${item.leaseExpiresAt}`);
  }
  if (!Array.isArray(item.history) || item.history.length === 0 || item.history[0]?.action !== "created") {
    problems.push("history missing or does not start with created");
  } else {
    for (const h of item.history) {
      if (typeof h?.at !== "string" || !Number.isFinite(Date.parse(h.at)) ||
          typeof h?.agentId !== "string" || typeof h?.action !== "string") {
        problems.push(`malformed history stamp: ${JSON.stringify(h).slice(0, 120)}`);
        break;
      }
    }
  }
  if (context?.expectOwner !== undefined && item.owner !== context.expectOwner) {
    problems.push(`owner ${item.owner} != expected ${context.expectOwner}`);
  }
  return { item, problems };
}

// Last ownership-changing stamp decides the expected owner.
function expectedOwnerFromHistory(item) {
  let owner = null; // created -> unclaimed
  for (const h of item.history ?? []) {
    if (h?.action === "claimed") owner = h.agentId;
    else if (h?.action === "state:unclaimed") owner = null;
  }
  return owner;
}

// --------------------------------------------------------------- A1 setup --
function seedClaim(reg, claimId, extra = {}) {
  reg.transaction(() => {
    reg.set(ROOM, createWork({ id: claimId, title: `fuzz ${claimId}`, ...extra }, { now: Date.now(), agentId: "system" }));
  });
}

function validClaimOpts(round, i, holderId) {
  const opts = {};
  const r = rng();
  if (r < 0.30) opts.leaseHours = pick([1, 24, 168]);
  if (rng() < 0.30) opts.note = `racer note ${round}-${i}`;
  if (rng() < 0.35) {
    opts.files = (rng() < 0.5 && holderId) ? ["fuzz/shared.txt"] : [`fuzz/r${round}-a${i}.txt`];
    if (holderId) opts.holderId = holderId;
    if (rng() < 0.25) opts.advisory = true; // proceed despite overlap
  }
  if (rng() < 0.15) opts.evidenceRefs = [`sha256:${"b".repeat(64)}`];
  return opts;
}

test("fuzz-02 A1: N-way claim races, exactly one winner, clean losers", async t => {
  const violations = [];
  const loserCodes = {};
  const heldCounts = new Map();
  let rounds = 0;
  for (let N = 2; N <= 16; N++) {
    for (let rep = 0; rep < 100; rep++) {
      const round = rounds++;
      const claimId = `fuzz-a1-${round}`;
      seedClaim(registry, claimId);
      // 25%: a live claim holding shared files, so some racers hit the
      // post-pure file-lease 409 (a clean loss inside the transaction).
      let holderId = null;
      if (rng() < 0.25) {
        holderId = `${claimId}-holder`;
        seedClaim(registry, holderId);
        registry.transaction(() => {
          registry.set(ROOM, claimWork(registry.get(ROOM, holderId), "conflict-holder",
            { files: ["fuzz/shared.txt"], now: Date.now() }));
        });
        heldCounts.set("conflict-holder", (heldCounts.get("conflict-holder") ?? 0) + 1);
      }
      const agents = Array.from({ length: N }, (_, i) => `fuzz-a1-r${round}-agent-${i}`);
      const attempts = agents.map((agent, i) => (async () => {
        await jitter(3); // randomize arrival order; the attempt itself is atomic
        const opts = i === 0 ? {} : validClaimOpts(round, i, holderId); // agent 0 always valid
        return { agent, ...(await (async () => asClean(() => routeClaim(registry, claimId, agent, opts, heldCounts)))()) };
      })());
      const results = await Promise.all(attempts);
      const winners = results.filter(r => r.ok);
      const losers = results.filter(r => !r.ok);
      for (const loser of losers) {
        if (loser.dirty) violations.push({ round, N, kind: "dirty-throw", agent: loser.agent, dirty: loser.dirty });
        else loserCodes[`${loser.status}/${loser.code}`] = (loserCodes[`${loser.status}/${loser.code}`] || 0) + 1;
      }
      if (winners.length !== 1) {
        violations.push({ round, N, kind: winners.length === 0 ? "no-winner" : "double-win",
          winners: winners.map(w => w.agent), losers: losers.map(l => `${l.agent}:${l.status}/${l.code}`) });
      }
      const { item, problems } = checkReadback(registry.get(ROOM, claimId),
        winners.length === 1 ? { expectOwner: winners[0].agent } : {});
      for (const p of problems) violations.push({ round, N, kind: "torn-state", problem: p });
      if (item) {
        const claimedStamps = item.history.filter(h => h.action === "claimed");
        if (claimedStamps.length !== 1) {
          violations.push({ round, N, kind: "history", problem: `expected 1 claimed stamp, saw ${claimedStamps.length}` });
        } else if (winners.length === 1 && claimedStamps[0].agentId !== winners[0].agent) {
          violations.push({ round, N, kind: "history", problem: "claimed stamp names a non-winner" });
        }
      }
    }
  }
  console.log(`[fuzz-02 A1] rounds=${rounds} loserCodes=${JSON.stringify(loserCodes)} violations=${violations.length}`);
  assert.equal(violations.length, 0, `A1 violations:\n${JSON.stringify(violations.slice(0, 5), null, 2)}`);
  assert.equal(rounds, 1500);
});

// --------------------------------------------------------------- A2 mixed --
test("fuzz-02 A2: claim+release+reclaim triples, mixed op races", async t => {
  const violations = [];
  const opOutcomes = {};
  const heldCounts = new Map();
  let rounds = 0;
  for (let rep = 0; rep < 600; rep++) {
    const round = rounds++;
    const claimId = `fuzz-a2-${round}`;
    seedClaim(registry, claimId);
    const agents = ["op-a", "op-b", "op-c", "op-d"].slice(0, 2 + randInt(3))
      .map(a => `fuzz-a2-r${round}-${a}`);
    const opCount = 3 + randInt(6); // 3..8 ops
    const ops = Array.from({ length: opCount }, () => {
      const kind = pick(["claim", "claim", "claim", "release", "release", "renew", "start"]);
      const agent = pick(agents);
      return { kind, agent };
    });
    const results = await Promise.all(ops.map(({ kind, agent }) => (async () => {
      await jitter(4);
      const run = kind === "claim" ? () => routeClaim(registry, claimId, agent, validClaimOpts(round, 0, null), heldCounts)
        : kind === "release" ? () => routeRelease(registry, claimId, agent, heldCounts)
        : kind === "renew" ? () => routeRenew(registry, claimId, agent)
        : () => routeStart(registry, claimId, agent);
      return { kind, agent, ...(await (async () => asClean(run))()) };
    })()));
    for (const r of results) {
      const key = r.ok ? `${r.kind}:ok` : (r.dirty ? `${r.kind}:DIRTY` : `${r.kind}:${r.status}/${r.code}`);
      opOutcomes[key] = (opOutcomes[key] || 0) + 1;
      if (r.dirty) violations.push({ round, kind: "dirty-throw", op: `${r.kind} by ${r.agent}`, dirty: r.dirty });
    }
    const { item, problems } = checkReadback(registry.get(ROOM, claimId));
    for (const p of problems) violations.push({ round, kind: "torn-state", problem: p,
      ops: results.map(r => `${r.kind}:${r.agent}:${r.ok ? "ok" : (r.dirty ? "DIRTY" : r.status)}`).join(" ") });
    if (item && item.owner !== expectedOwnerFromHistory(item)) {
      violations.push({ round, kind: "owner-history-mismatch",
        owner: item.owner, expected: expectedOwnerFromHistory(item),
        tail: item.history.slice(-4).map(h => `${h.action}:${h.agentId}`).join(" ") });
    }
  }
  console.log(`[fuzz-02 A2] rounds=${rounds} opOutcomes=${JSON.stringify(opOutcomes)} violations=${violations.length}`);
  assert.equal(violations.length, 0, `A2 violations:\n${JSON.stringify(violations.slice(0, 5), null, 2)}`);
  assert.equal(rounds, 600);
});

// ---------------------------------------------------------- A3 invalid ----
test("fuzz-02 A3: invalid-input races refuse cleanly, item stays pristine", async t => {
  const violations = [];
  const heldCounts = new Map();
  let rounds = 0;
  const bads = [
    { leaseHours: 999 },
    { leaseHours: "soon" },
    { note: "x".repeat(4001) },
    { dependsOn: ["fuzz-missing-dep"] },
    { files: ["../escape.txt"] },
    { files: [""] },
  ];
  for (let rep = 0; rep < 150; rep++) {
    const round = rounds++;
    const claimId = `fuzz-a3-${round}`;
    seedClaim(registry, claimId);
    const agents = [0, 1, 2, 3].map(i => `fuzz-a3-r${round}-agent-${i}`);
    const results = await Promise.all(agents.map((agent, i) => (async () => {
      await jitter(2);
      return { agent, ...(await (async () => asClean(() => routeClaim(registry, claimId, agent, { ...bads[(rep + i) % bads.length] }, heldCounts)))()) };
    })()));
    const winners = results.filter(r => r.ok);
    if (winners.length !== 0) violations.push({ round, kind: "invalid-won", winners: winners.map(w => w.agent) });
    for (const loser of results.filter(r => !r.ok)) {
      if (loser.dirty) violations.push({ round, kind: "dirty-throw", agent: loser.agent, dirty: loser.dirty });
      else if (loser.status !== 422) violations.push({ round, kind: "wrong-status", agent: loser.agent, got: `${loser.status}/${loser.code}` });
    }
    const { item, problems } = checkReadback(registry.get(ROOM, claimId), { expectOwner: null });
    for (const p of problems) violations.push({ round, kind: "torn-state", problem: p });
    if (item && (item.history.length !== 1 || item.state !== "unclaimed")) {
      violations.push({ round, kind: "item-mutated", state: item.state, history: item.history.length });
    }
  }
  console.log(`[fuzz-02 A3] rounds=${rounds} violations=${violations.length}`);
  assert.equal(violations.length, 0, `A3 violations:\n${JSON.stringify(violations.slice(0, 5), null, 2)}`);
  assert.equal(rounds, 150);
});

// --------------------------------------- B adversarial: no transaction ----
test("fuzz-02 B: hostile interleavings without the transaction boundary", async t => {
  // Deliberately NOT the shipped path: default no-op transaction + yields
  // between the steps. Documents that the transaction is load-bearing and
  // checks the loser path for torn rows (there should be none: whole-row
  // JSON replace is atomic in SQLite).
  let rounds = 0, doubleWins = 0, torn = 0, dirty = 0;
  let winnerCounts = {};
  for (let N = 2; N <= 16; N++) {
    for (let rep = 0; rep < 10; rep++) {
      const round = rounds++;
      const claimId = `fuzz-b-${round}`;
      seedClaim(registryB, claimId);
      const agents = Array.from({ length: N }, (_, i) => `fuzz-b-r${round}-agent-${i}`);
      const results = await Promise.all(agents.map(agent => (async () => {
        const run = async () => {
          const item = registryB.get(ROOM, claimId);
          await jitter(2);
          if (!item) throw typed(404, "work_claim_not_found");
          if (item.state !== "unclaimed") throw typed(409, "work_claim_conflict");
          await jitter(2);
          let claimed;
          try { claimed = claimWork(item, agent, { now: Date.now() }); }
          catch (error) { claimErrToRefusal(error); }
          await jitter(2);
          registryB.set(ROOM, claimed);
          return claimed;
        };
        await jitter(1);
        return { agent, ...(await asCleanAsync(run)) };
      })()));
      const winners = results.filter(r => r.ok);
      winnerCounts[winners.length] = (winnerCounts[winners.length] || 0) + 1;
      if (winners.length > 1) doubleWins++;
      for (const r of results) if (r.dirty) dirty++;
      const { problems } = checkReadback(registryB.get(ROOM, claimId));
      if (problems.length > 0) { torn++; }
    }
  }
  console.log(`[fuzz-02 B] rounds=${rounds} doubleWinRounds=${doubleWins} tornRows=${torn} dirtyThrows=${dirty} winnerHistogram=${JSON.stringify(winnerCounts)}`);
  assert.equal(rounds, 150);
  assert.equal(torn, 0, "adversarial interleavings must never tear a row");
  assert.equal(dirty, 0, "adversarial interleavings must never throw dirty errors");
  db.close(); dbB.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
