// tests/fuzz-21-fee-ledger.test.js — WAVE-400 fuzz worker: fee-credit ledger conservation.
//
// Target: server/fee-credit-ledger.mjs (recordTrialFee / applyCreditToPlacement /
// creditBalance / entries). Hand-rolled mulberry32, seeded. Independent model of
// expected successful ops; per-sequence invariant checks:
//
//   1. journal is append-only; failed ops mutate nothing
//   2. seq strictly increasing by 1
//   3. every entry double-entry balanced (debits == credits), per entry and in total
//   4. creditBalance(client) == sum of unapplied, unexpired fees (recomputed from model)
//   5. conservation per client:
//        sumFees == sumApplied + sumForfeited + activeBalance + expiredUnapplied
//   6. no negative balances (BigInt everywhere)
//
// Seed: Number(process.env.FUZZ_SEED ?? 20261008)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFeeCreditLedger,
  CREDIT_EXPIRY_DAYS,
} from "../server/fee-credit-ledger.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-21] fee-credit-ledger fuzz seed=${SEED}`);

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MS_PER_DAY = 86400000;
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

const VALID_FEES = [
  "0",
  "1",
  "2",
  "99",
  "100",
  "101",
  "999",
  "123456789012345678901234567890", // huge
  "007", // leading zeros
];
const INVALID_MINORS = [
  "",
  "-5",
  "3.5",
  "abc",
  "0x10",
  "5 ",
  " 5",
  "1_000",
  "+7",
  "NaN",
];
const INVALID_IDS = [""]; // non-empty-string required; non-strings below
const NON_STRING_IDS = [null, undefined, 42, {}, []];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Independent model of what the journal SHOULD contain.
class Model {
  constructor() {
    this.fees = new Map(); // key -> {clientId, trialTaskId, feeMinor:bigint, expiresAtMs, applied:null|{creditMinor:bigint, expiresAtMs, placementId}}
    this.ops = 0; // successful ops (journal entries expected)
  }
  key(clientId, trialTaskId) {
    return `${clientId}\n${trialTaskId}`;
  }
}

function assertInvariants(ledger, model, nowMs, label) {
  const journal = ledger.entries();
  // 1+2: append-only shape, seq strictly increasing by 1 from 1
  assert.equal(journal.length, model.ops, `${label}: journal length != model ops`);
  journal.forEach((e, i) => {
    assert.equal(e.seq, i + 1, `${label}: seq not strictly increasing at index ${i}`);
  });
  // 3: double-entry balance per entry and in total
  let totDebit = 0n;
  let totCredit = 0n;
  for (const e of journal) {
    let d = 0n;
    let c = 0n;
    for (const leg of e.legs) {
      const amt = BigInt(leg.amountMinor);
      assert.ok(amt >= 0n, `${label}: negative leg amount ${leg.amountMinor}`);
      if (leg.dc === "debit") d += amt;
      else if (leg.dc === "credit") c += amt;
      else assert.fail(`${label}: leg dc neither debit nor credit`);
    }
    assert.equal(d, c, `${label}: entry ${e.seq} unbalanced (${d} vs ${c})`);
    totDebit += d;
    totCredit += c;
  }
  assert.equal(totDebit, totCredit, `${label}: journal total unbalanced`);

  // applied set derivable from journal (single-use ⇒ at most one per key)
  const appliedFromJournal = new Map();
  for (const e of journal) {
    if (e.type === "credit-applied") {
      const k = `${e.clientId}\n${e.trialTaskId}`;
      assert.ok(!appliedFromJournal.has(k), `${label}: double-apply in journal for ${k}`);
      appliedFromJournal.set(k, e);
    }
  }
  // journal fees must match the model exactly
  const journalFees = new Map();
  for (const e of journal) {
    if (e.type === "trial-fee") {
      const k = `${e.clientId}\n${e.trialTaskId}`;
      assert.ok(!journalFees.has(k), `${label}: duplicate fee entry in journal for ${k}`);
      journalFees.set(k, e);
    }
  }
  assert.deepEqual(
    new Set(journalFees.keys()),
    new Set(model.fees.keys()),
    `${label}: journal fee keys != model fee keys`,
  );
  for (const [k, m] of model.fees) {
    const je = journalFees.get(k);
    assert.equal(BigInt(je.feeMinor).toString(), m.feeMinor.toString(), `${label}: feeMinor mismatch ${k}`);
    const applied = appliedFromJournal.get(k);
    if (m.applied) {
      assert.ok(applied, `${label}: model says applied but no journal entry ${k}`);
      assert.equal(applied.creditMinor, m.applied.creditMinor.toString(), `${label}: creditMinor mismatch ${k}`);
      // expiry clamp: explicit expiresAt may only shorten, never extend past fee expiry
      assert.ok(
        Date.parse(applied.expiresAt) <= Date.parse(je.expiresAt),
        `${label}: applied expiresAt extends fee expiry ${k}`,
      );
      // never applied after expiry
      assert.ok(
        Date.parse(applied.appliedAt) <= Date.parse(applied.expiresAt),
        `${label}: applied after expiry ${k}`,
      );
      // credit never exceeds fee
      assert.ok(m.applied.creditMinor <= m.feeMinor, `${label}: credit exceeds fee ${k}`);
    } else {
      assert.ok(!applied, `${label}: journal shows apply the model does not expect ${k}`);
    }
  }

  // 4+5: per-client balance + conservation
  const clients = new Set([...model.fees.values()].map((f) => f.clientId));
  for (const clientId of clients) {
    let sumFees = 0n;
    let sumApplied = 0n;
    let sumForfeited = 0n;
    let sumExpiredUnapplied = 0n;
    let expectedActive = 0n;
    for (const m of model.fees.values()) {
      if (m.clientId !== clientId) continue;
      sumFees += m.feeMinor;
      if (m.applied) {
        sumApplied += m.applied.creditMinor;
        sumForfeited += m.feeMinor - m.applied.creditMinor;
      } else if (nowMs > m.expiresAtMs) {
        sumExpiredUnapplied += m.feeMinor;
      } else {
        expectedActive += m.feeMinor;
      }
    }
    assert.equal(
      sumFees,
      sumApplied + sumForfeited + expectedActive + sumExpiredUnapplied,
      `${label}: conservation broken for client ${clientId}`,
    );
    const bal = BigInt(ledger.creditBalance({ clientId }));
    assert.ok(bal >= 0n, `${label}: negative balance for ${clientId}`);
    assert.equal(
      bal.toString(),
      expectedActive.toString(),
      `${label}: creditBalance mismatch for ${clientId} (got ${bal}, want ${expectedActive})`,
    );
  }
}

function runSequence(seqIdx) {
  const rng = mulberry32((SEED ^ (seqIdx * 0x9e3779b1)) >>> 0);
  let nowMs = BASE_MS;
  const ledger = createFeeCreditLedger({ now: () => nowMs });
  const model = new Model();
  const label = `seq${seqIdx}`;

  const clients = ["c0", "c1", "c2", "c3", "c4"];
  const knownTrials = []; // {clientId, trialTaskId} ever successfully recorded
  const placements = ["p0", "p1", "p2"];
  const nOps = 5 + Math.floor(rng() * 25);

  for (let i = 0; i < nOps; i++) {
    const roll = rng();
    if (roll < 0.35) {
      // ---- recordTrialFee ----
      const clientId = rng() < 0.08 ? pick(rng, INVALID_IDS) : pick(rng, clients);
      const nonStr = rng() < 0.05 ? pick(rng, NON_STRING_IDS) : null;
      let trialTaskId;
      if (nonStr !== null) trialTaskId = nonStr;
      else if (rng() < 0.3 && knownTrials.length) trialTaskId = pick(rng, knownTrials).trialTaskId; // dup attempt
      else trialTaskId = rng() < 0.1 ? pick(rng, INVALID_IDS) : `t-${seqIdx}-${i}-${Math.floor(rng() * 4)}`;
      const feeMinor =
        rng() < 0.12 ? pick(rng, INVALID_MINORS) : pick(rng, VALID_FEES);

      const before = ledger.entries().length;
      const key = `${clientId}\n${trialTaskId}`;
      const expectOk =
        typeof clientId === "string" &&
        clientId.length > 0 &&
        typeof trialTaskId === "string" &&
        trialTaskId.length > 0 &&
        /^\d+$/.test(feeMinor) &&
        !model.fees.has(key);
      let threw = null;
      try {
        ledger.recordTrialFee({ clientId, trialTaskId, feeMinor });
      } catch (e) {
        threw = e;
      }
      if (expectOk) {
        assert.equal(threw, null, `${label} op${i}: recordTrialFee unexpectedly threw: ${threw && threw.message}`);
        const expiresAtMs = nowMs + CREDIT_EXPIRY_DAYS * MS_PER_DAY;
        model.fees.set(key, {
          clientId,
          trialTaskId,
          feeMinor: BigInt(feeMinor),
          expiresAtMs,
          applied: null,
        });
        model.ops++;
        knownTrials.push({ clientId, trialTaskId });
      } else {
        assert.ok(threw, `${label} op${i}: recordTrialFee should have thrown`);
        assert.equal(
          ledger.entries().length,
          before,
          `${label} op${i}: failed record mutated journal`,
        );
      }
    } else if (roll < 0.7) {
      // ---- applyCreditToPlacement ----
      let clientId;
      let trialTaskId;
      let feeMinor = null; // known model fee, if any
      if (rng() < 0.25 || knownTrials.length === 0) {
        clientId = pick(rng, clients);
        trialTaskId = `unknown-${seqIdx}-${i}`;
      } else {
        const kt = pick(rng, knownTrials);
        clientId = kt.clientId;
        trialTaskId = kt.trialTaskId;
        const m = model.fees.get(model.key(clientId, trialTaskId));
        if (m) feeMinor = m.feeMinor;
      }
      const placementId = rng() < 0.06 ? "" : pick(rng, placements);
      // choose credit amount: valid (<= fee) / hostile (> fee) / zero / invalid
      const r2 = rng();
      let creditMinor;
      if (r2 < 0.4 && feeMinor !== null && feeMinor > 0n) {
        // <= fee: either exact or a fraction
        creditMinor = rng() < 0.5 ? feeMinor.toString() : (feeMinor / 2n || 1n).toString();
      } else if (r2 < 0.55) {
        creditMinor = "9".repeat(40); // hostile huge, exceeds any valid fee
      } else if (r2 < 0.65) {
        creditMinor = "0"; // must throw (>0 required)
      } else if (r2 < 0.75) {
        creditMinor = pick(rng, INVALID_MINORS);
      } else if (feeMinor !== null && feeMinor > 1n) {
        creditMinor = (feeMinor - 1n).toString(); // partial ⇒ remainder forfeited
      } else {
        creditMinor = "1";
      }
      // expiresAt override: none / shorter / longer (clamped) / past / invalid
      const r3 = rng();
      let expiresAt;
      const feeRec = feeMinor !== null ? model.fees.get(model.key(clientId, trialTaskId)) : null;
      if (r3 < 0.6) expiresAt = undefined;
      else if (r3 < 0.72) expiresAt = new Date(nowMs + MS_PER_DAY).toISOString(); // shorter
      else if (r3 < 0.84) expiresAt = new Date(nowMs + 400 * MS_PER_DAY).toISOString(); // longer → clamped
      else if (r3 < 0.92) expiresAt = new Date(nowMs - MS_PER_DAY).toISOString(); // past → expired
      else expiresAt = "not-a-date"; // → TypeError

      const before = ledger.entries().length;
      let expectOk = true;
      if (typeof clientId !== "string" || clientId.length === 0) expectOk = false;
      if (typeof placementId !== "string" || placementId.length === 0) expectOk = false;
      if (typeof trialTaskId !== "string" || trialTaskId.length === 0) expectOk = false;
      if (!/^\d+$/.test(creditMinor) || BigInt(creditMinor) <= 0n) expectOk = false;
      if (typeof expiresAt === "string" && Number.isNaN(Date.parse(expiresAt))) expectOk = false;
      if (expectOk) {
        if (!feeRec) expectOk = false; // unknown fee
        else if (feeRec.applied) expectOk = false; // double-apply
        else if (BigInt(creditMinor) > feeRec.feeMinor) expectOk = false; // exceeds fee
        else {
          const feeExp = feeRec.expiresAtMs;
          const effExp =
            expiresAt === undefined ? feeExp : Math.min(feeExp, Date.parse(expiresAt));
          if (nowMs > effExp) expectOk = false; // expired
        }
      }
      let threw = null;
      try {
        ledger.applyCreditToPlacement({ clientId, placementId, trialTaskId, creditMinor, expiresAt });
      } catch (e) {
        threw = e;
      }
      if (expectOk) {
        assert.equal(threw, null, `${label} op${i}: apply unexpectedly threw: ${threw && threw.message}`);
        feeRec.applied = {
          creditMinor: BigInt(creditMinor),
          expiresAtMs: Math.min(
            feeRec.expiresAtMs,
            expiresAt === undefined ? Infinity : Date.parse(expiresAt),
          ),
          placementId,
        };
        model.ops++;
      } else {
        assert.ok(threw, `${label} op${i}: apply should have thrown`);
        assert.equal(
          ledger.entries().length,
          before,
          `${label} op${i}: failed apply mutated journal`,
        );
      }
    } else if (roll < 0.85) {
      // ---- advance the clock (expiry fuzzing) ----
      nowMs += Math.floor(rng() * 400) * MS_PER_DAY;
    } else {
      // ---- read-only probes: balance of unknown clients, entries frozen ----
      const clientId = rng() < 0.5 ? pick(rng, clients) : `nobody-${seqIdx}-${i}`;
      const b = ledger.creditBalance({ clientId });
      assert.ok(/^\d+$/.test(b), `${label}: balance not a minor string: ${b}`);
      const es = ledger.entries();
      assert.ok(Object.isFrozen(es), `${label}: entries() not frozen`);
      if (es.length) {
        assert.ok(Object.isFrozen(es[0]), `${label}: entry not frozen`);
        assert.ok(Object.isFrozen(es[0].legs), `${label}: legs not frozen`);
      }
    }
    assertInvariants(ledger, model, nowMs, `${label}/op${i}`);
  }
  assertInvariants(ledger, model, nowMs, `${label}/final`);
}

test("fuzz: 10,000 random fee-credit ledger sequences conserve", () => {
  const N = 10000;
  for (let s = 0; s < N; s++) runSequence(s);
  console.log(`[fuzz-21] ${N} sequences done, seed=${SEED}, no invariant violations`);
});
