// Lane 9 (acp-build-escrow-eventlog): escrow event log / audit ledger tests.
//
// Authoring-gate answers (test-audit SKILL.md):
// 1. Contracts: an append-only, hash-chained settlement trail — genesis +
//    ordering grammar per escrow, exactly-once settled, commit-reveal
//    binding for verdicts, frozen entries, monotonic timestamps, and a
//    stranger-friendly verify() that pinpoints the first broken link.
// 2. Credible regressions: a store-level entry swap going undetected,
//    out-of-order events accepted, double settled, reveal without a
//    matching commitment, appends after the terminal event, timestamps
//    moving backwards.
// 3. Existing coverage gap: claim-escrow owns the escrow state machine,
//    bounty-disputes owns the dispute ladder — nothing owns the
//    tamper-evident settlement trail. This module is the contract owner.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createEscrowEventLogs, EventLogError, EVENT_TYPES,
  GENESIS_PREV_HASH, verdictCommitment,
} from "../server/escrow-eventlog.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, error => error instanceof EventLogError && error.code === code);

const T0 = "2026-10-07T06:00:00.000Z";
const T1 = "2026-10-07T06:01:00.000Z";
const T2 = "2026-10-07T06:02:00.000Z";
const T3 = "2026-10-07T06:03:00.000Z";
const T4 = "2026-10-07T06:04:00.000Z";
const T5 = "2026-10-07T06:05:00.000Z";
const HASH = c => `sha256:${c.repeat(64)}`;

const CREATED = { claimId: "claim-9", claimant: "agent:quill", bondUnits: 100, denomination: "dasha-paper" };

function fresh() { return createEscrowEventLogs(); }
function created(logs, id = "e1", at = T0) {
  return logs.append(id, { type: "escrow_created", actor: "agent:quill", at, payload: { ...CREATED } });
}
// Drives an escrow through to a revealed approve verdict.
function toRevealed(logs, id = "e1", secret = "s3cr3t") {
  created(logs, id);
  logs.append(id, { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  logs.append(id, { type: "work_submitted", actor: "agent:quill", at: T2,
    payload: { by: "agent:quill", evidenceHash: HASH("b") } });
  const commitment = verdictCommitment({ outcome: "approve", reasonCodes: ["criteria-met"], secret });
  logs.append(id, { type: "verdict_committed", actor: "agent:instinct", at: T3,
    payload: { evaluator: "agent:instinct", commitment } });
  return logs.append(id, { type: "verdict_revealed", actor: "agent:instinct", at: T4,
    payload: { evaluator: "agent:instinct", outcome: "approve", reasonCodes: ["criteria-met"], secret } });
}
function settledReleased(logs, id = "e1", at = T5) {
  return logs.append(id, { type: "settled", actor: "agent:instinct", at,
    payload: { terminal: "released", disposition: "claimant", bondSnapshot: 100,
      verdict: { outcome: "approve", reasonCodes: ["criteria-met"] }, cause: null } });
}

test("happy path: full chain links, genesis, frozen entries, verify ok", () => {
  const logs = fresh();
  toRevealed(logs);
  const first = logs.entries("e1")[0];
  assert.equal(first.seq, 0);
  assert.equal(first.prevHash, GENESIS_PREV_HASH);
  assert.equal(GENESIS_PREV_HASH, "0".repeat(64));
  assert.ok(Object.isFrozen(first));
  settledReleased(logs);
  const entries = logs.entries("e1");
  assert.equal(entries.length, 6);
  assert.deepEqual(entries.map(e => e.type), [
    "escrow_created", "bond_locked", "work_submitted",
    "verdict_committed", "verdict_revealed", "settled",
  ]);
  for (let i = 1; i < entries.length; i++) assert.equal(entries[i].prevHash, entries[i - 1].hash);
  assert.equal(logs.head("e1").hash, entries[entries.length - 1].hash);
  const v = logs.verify("e1");
  assert.equal(v.ok, true);
  assert.equal(v.entries, 6);
  assert.equal(v.head, logs.head("e1").hash);
});

test("verify detects a store-level entry swap at the forged link", () => {
  const store = new Map();
  const logs = createEscrowEventLogs({ store });
  created(logs);
  logs.append("e1", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  // Attacker swaps entry 1 for a same-shape entry with a fatter snapshot.
  // (Entries are frozen, so the swap happens at the store level — exactly
  // what a stranger re-reading a persisted store would catch.)
  const forged = { ...store.get("e1")[1],
    payload: { bondSnapshot: 9999, by: "agent:quill" } };
  store.set("e1", [store.get("e1")[0], Object.freeze(forged)]);
  const v = logs.verify("e1");
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.match(v.reason, /hash/);
});

test("ordering grammar: streams open with escrow_created, exactly once", () => {
  const logs = fresh();
  throwsCode(() => logs.append("e1", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } }), "invalid_stream");
  created(logs);
  throwsCode(() => logs.append("e1", { type: "escrow_created", actor: "agent:quill", at: T1,
    payload: { ...CREATED } }), "duplicate_genesis");
  throwsCode(() => logs.append("e1", { type: "work_submitted", actor: "agent:quill", at: T1,
    payload: { by: "agent:quill", evidenceHash: HASH("b") } }), "invalid_stream");
});

test("settled is terminal and exactly once; nothing appends after it", () => {
  const logs = fresh();
  toRevealed(logs);
  settledReleased(logs);
  throwsCode(() => settledReleased(logs, "e1"), "settled_final");
  throwsCode(() => logs.append("e1", { type: "expired", actor: "escrow-keeper", at: T5,
    payload: { from: "bond_locked", cause: "lease_lapsed" } }), "settled_final");
});

test("verdict reveal must match the prior commitment", () => {
  const logs = fresh();
  created(logs);
  logs.append("e1", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  logs.append("e1", { type: "work_submitted", actor: "agent:quill", at: T2,
    payload: { by: "agent:quill", evidenceHash: HASH("b") } });
  // reveal with no commit on record: out of order (verdict_revealed only follows verdict_committed)
  throwsCode(() => logs.append("e1", { type: "verdict_revealed", actor: "agent:instinct", at: T3,
    payload: { evaluator: "agent:instinct", outcome: "approve", reasonCodes: ["criteria-met"], secret: "x" } }),
    "invalid_stream");
  const commitment = verdictCommitment({ outcome: "approve", reasonCodes: ["criteria-met"], secret: "s3cr3t" });
  logs.append("e1", { type: "verdict_committed", actor: "agent:instinct", at: T3,
    payload: { evaluator: "agent:instinct", commitment } });
  // wrong secret
  throwsCode(() => logs.append("e1", { type: "verdict_revealed", actor: "agent:instinct", at: T4,
    payload: { evaluator: "agent:instinct", outcome: "approve", reasonCodes: ["criteria-met"], secret: "wrong" } }),
    "commitment_mismatch");
  // different evaluator than the committer
  throwsCode(() => logs.append("e1", { type: "verdict_revealed", actor: "agent:fo", at: T4,
    payload: { evaluator: "agent:fo", outcome: "approve", reasonCodes: ["criteria-met"], secret: "s3cr3t" } }),
    "commitment_mismatch");
  // changed verdict after the commit
  throwsCode(() => logs.append("e1", { type: "verdict_revealed", actor: "agent:instinct", at: T4,
    payload: { evaluator: "agent:instinct", outcome: "reject", reasonCodes: ["criteria-unmet"], secret: "s3cr3t" } }),
    "commitment_mismatch");
});

test("withdraw path: bond_locked -> settled (refunded, cause withdraw)", () => {
  const logs = fresh();
  created(logs);
  logs.append("e1", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  const s = logs.append("e1", { type: "settled", actor: "agent:quill", at: T2,
    payload: { terminal: "refunded", disposition: "claimant", bondSnapshot: 100, verdict: null, cause: "withdraw" } });
  assert.equal(s.type, "settled");
  assert.equal(logs.verify("e1").ok, true);
  // settled without a cause after bond_locked is not a withdraw
  const logs2 = fresh();
  created(logs2, "e2");
  logs2.append("e2", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  throwsCode(() => logs2.append("e2", { type: "settled", actor: "agent:quill", at: T2,
    payload: { terminal: "refunded", disposition: "claimant", bondSnapshot: 100, verdict: null, cause: null } }),
    "invalid_payload");
});

test("expired path: keeper-attributed, then settled; wrong actor refused", () => {
  const logs = fresh();
  created(logs);
  logs.append("e1", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  throwsCode(() => logs.append("e1", { type: "expired", actor: "agent:quill", at: T2,
    payload: { from: "bond_locked", cause: "lease_lapsed" } }), "invalid_actor");
  logs.append("e1", { type: "expired", actor: "escrow-keeper", at: T2,
    payload: { from: "bond_locked", cause: "lease_lapsed" } });
  logs.append("e1", { type: "settled", actor: "escrow-keeper", at: T3,
    payload: { terminal: "expired", disposition: "claimant", bondSnapshot: 100, verdict: null, cause: "lease_lapsed" } });
  assert.equal(logs.verify("e1").ok, true);
  // expired must name the true phase it fires from
  const logs2 = fresh();
  created(logs2, "e2");
  logs2.append("e2", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  throwsCode(() => logs2.append("e2", { type: "expired", actor: "escrow-keeper", at: T2,
    payload: { from: "work_submitted", cause: "lease_lapsed" } }), "invalid_payload");
});

test("settled enforces the disposition direction and verdict pairing", () => {
  const logs = fresh();
  toRevealed(logs);
  // released pays the claimant, never the room pool
  throwsCode(() => logs.append("e1", { type: "settled", actor: "agent:instinct", at: T5,
    payload: { terminal: "released", disposition: "room_pool", bondSnapshot: 100,
      verdict: { outcome: "approve", reasonCodes: ["criteria-met"] }, cause: null } }), "invalid_payload");
  // a released terminal needs the approve verdict on record
  throwsCode(() => logs.append("e1", { type: "settled", actor: "agent:instinct", at: T5,
    payload: { terminal: "released", disposition: "claimant", bondSnapshot: 100,
      verdict: { outcome: "reject", reasonCodes: ["criteria-unmet"] }, cause: null } }), "invalid_payload");
  settledReleased(logs);
  assert.equal(logs.verify("e1").ok, true);
});

test("timestamps must be valid ISO and monotonic within a stream", () => {
  const logs = fresh();
  throwsCode(() => logs.append("e1", { type: "escrow_created", actor: "agent:quill", at: "not-a-time",
    payload: { ...CREATED } }), "invalid_timestamp");
  created(logs, "e1", T1);
  throwsCode(() => logs.append("e1", { type: "bond_locked", actor: "agent:quill", at: T0,
    payload: { bondSnapshot: 100, by: "agent:quill" } }), "time_went_backwards");
});

test("payload shapes are validated per event type", () => {
  const logs = fresh();
  throwsCode(() => logs.append("e1", { type: "nope", actor: "agent:quill", at: T0, payload: {} }), "unknown_event");
  throwsCode(() => logs.append("e1", { type: "escrow_created", actor: "agent:quill", at: T0,
    payload: { ...CREATED, denomination: "usdc" } }), "invalid_payload");
  throwsCode(() => logs.append("e1", { type: "escrow_created", actor: "agent:quill", at: T0,
    payload: { ...CREATED, bondUnits: 0 } }), "invalid_payload");
  created(logs, "e2");
  throwsCode(() => logs.append("e2", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:fo" } }), "invalid_payload"); // not the claimant
  logs.append("e2", { type: "bond_locked", actor: "agent:quill", at: T1,
    payload: { bondSnapshot: 100, by: "agent:quill" } });
  throwsCode(() => logs.append("e2", { type: "work_submitted", actor: "agent:quill", at: T2,
    payload: { by: "agent:quill", evidenceHash: "nope" } }), "invalid_payload");
  throwsCode(() => logs.entries("ghost"), "unknown_escrow");
  throwsCode(() => logs.verify("ghost"), "unknown_escrow");
  throwsCode(() => logs.head("ghost"), "unknown_escrow");
});

test("verdictCommitment is deterministic and binds outcome, codes, and secret", () => {
  const a = verdictCommitment({ outcome: "approve", reasonCodes: ["criteria-met"], secret: "s3cr3t" });
  const b = verdictCommitment({ outcome: "approve", reasonCodes: ["criteria-met"], secret: "s3cr3t" });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, verdictCommitment({ outcome: "approve", reasonCodes: ["criteria-met"], secret: "other" }));
  assert.notEqual(a, verdictCommitment({ outcome: "reject", reasonCodes: ["criteria-met"], secret: "s3cr3t" }));
  assert.notEqual(a, verdictCommitment({ outcome: "approve", reasonCodes: ["evidence-insufficient"], secret: "s3cr3t" }));
  // reason-code order does not matter; the set does
  assert.equal(
    verdictCommitment({ outcome: "approve", reasonCodes: ["criteria-met", "evidence-insufficient"], secret: "s" }),
    verdictCommitment({ outcome: "approve", reasonCodes: ["evidence-insufficient", "criteria-met"], secret: "s" }));
});

test("verifyAll reports per-escrow results; size counts streams", () => {
  const logs = fresh();
  toRevealed(logs, "e1");
  settledReleased(logs, "e1");
  created(logs, "e2", T0);
  assert.equal(logs.size(), 2);
  const all = logs.verifyAll();
  assert.equal(all.length, 2);
  const byId = Object.fromEntries(all.map(r => [r.escrowId, r]));
  assert.equal(byId.e1.ok, true);
  assert.equal(byId.e1.entries, 6);
  assert.equal(byId.e2.ok, true);
  assert.equal(byId.e2.entries, 1);
});

test("EVENT_TYPES vocabulary is the seven fixed events", () => {
  assert.deepEqual([...EVENT_TYPES], [
    "escrow_created", "bond_locked", "work_submitted",
    "verdict_committed", "verdict_revealed", "expired", "settled",
  ]);
});
