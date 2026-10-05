// Property-based tests for the spend-grants money paths (server/spend-grants.mjs).
//
// Zero-Bug System Phase 2, workstream 2b (ordered by the owner).
//
// APPROACH: fast-check generates arbitrary charge sequences (issue →
// authorize → settle/void/replay interleavings) and drives them through the
// REAL module against in-memory node:sqlite databases carrying the production
// schema. A local ledger models the expected balances; assertions pin
// invariants on the exported production functions only (authorizeSpend, the
// settle()/void() handles it returns, remainingSpendCents, spendGrantSummary)
// — never on table internals.
//
// PROPERTIES:
//   P1 conservation — a charge never exceeds the grant balance: settled totals
//      never exceed the cap, remaining is exactly cap − settled − reserved and
//      never negative, and a refused charge changes nothing.
//   P2 idempotency — the same nonce never double-charges: replaying a settled
//      nonce returns its receipt at the ORIGINAL price (even when a different
//      price is re-presented); replaying a reserved nonce returns the live
//      handle; re-presenting a voided nonce throws 409. Replays never move money.
//   P3 single-use admission — at most one in-flight authorization per
//      single-use grant; the first settle revokes the grant (later
//      authorizations 402 with grant_revoked, remaining drops to 0).
//   P4 per-agent isolation — interleaved charges for two agents never leak
//      across grants: each agent's ledger depends only on its own ops.
//   P5 room-allowance nesting — active room reservations never exceed the
//      allowance headroom (allowance − committed − in-flight); every
//      authorization's outcome matches the model exactly.
//
// COVERAGE LIMITS (what these tests do NOT prove):
//   - real concurrent transactions (see tests/spend-grant-races.test.js);
//   - the chargeSpendBeforeCall trust boundary (store-level; see
//     tests/spend-grants.test.js);
//   - the spend-pricing kill switch (see tests/spend-pricing.test.js).
//
// AUTHORING GATE (.agents/skills/test-audit/SKILL.md): the contracts are the
// charge-then-forward invariants in server/spend-grants.mjs's module docblock.
// Credible regressions: an arithmetic rewrite of the cents plumbing or the
// replay logic double-charging, leaking money across agents, or silently
// widening the room allowance (the 2026-10-05 qaD-fix-spend-race fixes exist
// precisely because that math is load-bearing). Existing deterministic tests
// (spend-grants.test.js, spend-grant-races.test.js) own one-trace examples;
// this file is the distinct sequence-space + invariant layer — no existing
// test enumerates arbitrary authorize/settle/void/replay interleavings.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import {
  ensureSpendGrantsSchema,
  SpendGrantError,
  issueSpendGrant,
  authorizeSpend,
  settleSpend,
  voidSpend,
  remainingSpendCents,
  spendGrantSummary,
} from "../server/spend-grants.mjs";
import { ensureGrantsSchema } from "../server/grants.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

// Fixed default seed (repo convention, cf. tests/claims-state-machine.property.test.js);
// PROPERTY_TEST_SEED shifts the exploration for an extra run.
const seedBase = Number(process.env.PROPERTY_TEST_SEED ?? 20261005);
const RUNS = 100;

const ROOM_ID = "prop-room";
const OWNER = "prop-owner";
const TOOL = "room_put_file"; // a priced tool; priceCents is supplied per call
const NONCE_POOL = 4;

// assert.throws returns undefined on this Node; capture the error instead.
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

// Unique agent ids per fast-check run (grants are keyed on room_id+agent_id,
// so fresh ids isolate runs on the shared per-test database).
let agentSeq = 0;
const freshAgent = () => `prop-a-${agentSeq++}`;
// Room reservations are room-scoped, so the room-allowance property (P5)
// needs a fresh room per run to isolate each run's reservations.
let roomSeq = 0;
const freshRoom = () => `prop-room-${roomSeq++}`;

function database(t) {
  const db = new DatabaseSync(":memory:");
  ensureGrantsSchema(db);
  ensureAutonomyTiersSchema(db);
  ensureSpendGrantsSchema(db);
  t.after(() => db.close());
  return db;
}

const grantParamsArb = fc.integer({ min: 1, max: 500 }).chain(cap =>
  fc.record({ cap: fc.constant(cap), perTx: fc.integer({ min: 1, max: cap }) }));

const opArb = multiAgent => fc.record({
  ...(multiAgent ? { agentIdx: fc.constantFrom(0, 1) } : {}),
  kind: fc.constantFrom("auth", "auth", "auth", "settle", "void"),
  nonceIdx: fc.integer({ min: 0, max: NONCE_POOL - 1 }),
  price: fc.integer({ min: 1, max: 1000 }),
});
const opsArb = multiAgent => fc.array(opArb(multiAgent), { minLength: 1, maxLength: 20 });

function makeLedger(agentId, cap, perTx, singleUse) {
  return {
    agentId, cap, perTx, singleUse,
    nonces: new Map(), // nonceIdx -> { price, state: "reserved"|"settled"|"voided", handle }
    settledTotal: 0,
    reservedTotal: 0,
    activeRoom: 0, // reservations against the room allowance not yet settled/voided
    grantDead: false, // single-use grants die on first settle
  };
}
const ledgerRemaining = ledger =>
  ledger.grantDead ? 0 : Math.max(0, ledger.cap - ledger.settledTotal - ledger.reservedTotal);

// Expected first-presentation outcome, mirroring the module's check order:
// revoked → per-tx cap → single-use admission → grant balance → room allowance.
function expectedFirstPresentation(ledger, price, room) {
  if (ledger.grantDead) return { status: 402, code: "payment_required", reason: "grant_revoked" };
  if (price > ledger.perTx) return { status: 402, code: "payment_required", reason: "per_tx_cap_exceeded" };
  if (ledger.singleUse && ledger.reservedTotal > 0)
    return { status: 409, code: "single_use_in_flight" };
  if (price > ledgerRemaining(ledger)) return { status: 402, code: "payment_required", reason: "cap_exceeded" };
  if (room && price > room.allowance - room.committed - ledger.activeRoom)
    return { status: 402, code: "payment_required", reason: "room_allowance_exceeded" };
  return null;
}

function authArgs(ledger, roomId, price, nonce, room, nowMs) {
  const args = { roomId, agentId: ledger.agentId, toolName: TOOL, priceCents: price, nonce, nowMs };
  if (room) { args.roomAllowanceCents = room.allowance; args.roomCommittedCents = room.committed; }
  return args;
}

// Drives one op sequence across the ledgers, asserting every money invariant
// through the module's exported functions only.
function drive(db, roomId, ledgers, room, ops, nowMs) {
  for (const ledger of ledgers) {
    issueSpendGrant(db, roomId, ledger.agentId, {
      grantedBy: OWNER,
      capCents: String(ledger.cap),
      perTxCapCents: String(ledger.perTx),
      singleUse: ledger.singleUse,
      nowMs,
    });
  }
  for (const op of ops) {
    const ledger = ledgers[op.agentIdx ?? 0];
    // Nonce includes the agent id: spend_room_reservations is keyed on
    // (room_id, nonce), and agent ids are unique per fast-check run, so this
    // keeps each run's room reservations isolated on the shared test database.
    const nonce = `${ledger.agentId}-n${op.nonceIdx}`;
    const entry = ledger.nonces.get(op.nonceIdx);

    if (op.kind === "auth") {
      if (entry) {
        // Replay of an already-presented nonce: never a second charge.
        const before = Number(remainingSpendCents(db, roomId, ledger.agentId));
        if (entry.state === "reserved" || entry.state === "settled") {
          const handle = authorizeSpend(db, authArgs(ledger, roomId, op.price, nonce, room, nowMs));
          assert.equal(handle.replayed, entry.state, "replay reports the stored authorization status");
          assert.equal(handle.priceCents, entry.price, "a replay settles at the original price, not the re-presented one");
          assert.equal(Number(handle.remainingAfterCents), before, "a replay never moves money");
          assert.equal(Number(remainingSpendCents(db, roomId, ledger.agentId)), before, "a replay never moves money");
        } else {
          const error = capture(() => authorizeSpend(db, authArgs(ledger, roomId, op.price, nonce, room, nowMs)));
          assert.ok(error instanceof SpendGrantError, `expected SpendGrantError, got ${error}`);
          assert.equal(error.status, 409, "a voided nonce stays consumed");
          assert.equal(error.code, "duplicate_nonce");
        }
      } else {
        // First presentation.
        const before = Number(remainingSpendCents(db, roomId, ledger.agentId));
        const expected = expectedFirstPresentation(ledger, op.price, room);
        if (expected === null) {
          const handle = authorizeSpend(db, authArgs(ledger, roomId, op.price, nonce, room, nowMs));
          assert.equal(Number(handle.remainingAfterCents), ledgerRemaining(ledger) - op.price,
            "remainingAfter equals the ledger balance after this charge");
          ledger.nonces.set(op.nonceIdx, { price: op.price, state: "reserved", handle });
          ledger.reservedTotal += op.price;
          if (room) ledger.activeRoom += op.price;
        } else {
          const error = capture(() => authorizeSpend(db, authArgs(ledger, roomId, op.price, nonce, room, nowMs)));
          assert.ok(error instanceof SpendGrantError, `expected SpendGrantError, got ${error}`);
          assert.equal(error.status, expected.status, `price ${op.price} vs cap ${ledger.cap}/perTx ${ledger.perTx}`);
          assert.equal(error.code, expected.code);
          if (expected.reason) assert.equal(error.detail?.reason, expected.reason);
          assert.equal(Number(remainingSpendCents(db, roomId, ledger.agentId)), before,
            "a refused charge changes nothing");
        }
      }
    } else if (op.kind === "settle") {
      if (entry && entry.state === "reserved") {
        assert.equal(entry.handle.settle(), true, "settling a live reservation moves it to settled");
        entry.state = "settled";
        ledger.settledTotal += entry.price;
        ledger.reservedTotal -= entry.price;
        if (room) ledger.activeRoom -= entry.price;
        if (ledger.singleUse) ledger.grantDead = true; // first settle revokes the grant
      } else if (entry) {
        assert.equal(entry.handle.settle(), false, "settling twice is a no-op, not a second charge");
      } else {
        assert.equal(settleSpend(db, { roomId, agentId: ledger.agentId, nonce }), false, "settling an unknown nonce is a no-op");
      }
    } else {
      if (entry && entry.state === "reserved") {
        assert.equal(entry.handle.void(), true, "voiding a live reservation releases it");
        entry.state = "voided";
        ledger.reservedTotal -= entry.price;
        if (room) ledger.activeRoom -= entry.price;
      } else if (entry) {
        assert.equal(entry.handle.void(), false, "voiding a settled/voided authorization is a no-op");
      } else {
        assert.equal(voidSpend(db, { roomId, agentId: ledger.agentId, nonce }), false, "voiding an unknown nonce is a no-op");
      }
    }

    // Invariants after every op, through the exported reads only.
    assert.equal(Number(remainingSpendCents(db, roomId, ledger.agentId)), ledgerRemaining(ledger),
      "remaining always tracks cap − settled − reserved");
    assert.ok(ledger.settledTotal <= ledger.cap, "settled charges never exceed the grant cap");
    assert.ok(ledgerRemaining(ledger) >= 0, "remaining never goes negative");
    if (room) {
      assert.ok(room.allowance - room.committed - ledger.activeRoom >= 0,
        "active room reservations never exceed the allowance headroom");
    }
  }
  // Summary consistency at the end of the sequence.
  for (const ledger of ledgers) {
    const summary = spendGrantSummary(db, roomId, ledger.agentId, { nowMs });
    if (ledger.grantDead) {
      assert.equal(summary, null, "a revoked single-use grant has no live summary");
    } else {
      assert.equal(Number(summary.remainingCents), ledgerRemaining(ledger), "the summary reports the ledger balance");
    }
  }
}

test("P1 conservation: a charge never exceeds the grant balance; remaining tracks the ledger; refused charges change nothing", async t => {
  const db = database(t);
  const nowMs = Date.now();
  await fc.assert(fc.property(
    grantParamsArb,
    opsArb(false),
    (params, ops) => {
      drive(db, ROOM_ID, [makeLedger(freshAgent(), params.cap, params.perTx, false)], null, ops, nowMs);
    },
  ), { seed: seedBase, numRuns: RUNS });
});

test("P2 idempotency: the same nonce never double-charges across authorize/settle/void/replay interleavings", async t => {
  const db = database(t);
  const nowMs = Date.now();
  // Replay-heavy sequences: re-presented prices differ from the original on purpose.
  const replayOps = fc.array(fc.record({
    kind: fc.constantFrom("auth", "auth", "settle", "void"),
    nonceIdx: fc.integer({ min: 0, max: 2 }),
    price: fc.integer({ min: 1, max: 300 }),
  }), { minLength: 5, maxLength: 25 });
  await fc.assert(fc.property(
    grantParamsArb,
    replayOps,
    (params, ops) => {
      const ledger = makeLedger(freshAgent(), params.cap, params.perTx, false);
      drive(db, ROOM_ID, [ledger], null, ops, nowMs);
      // Exactly-once at the ledger level: each nonce contributed at most its
      // first price to the settled total, never twice.
      let perNonceCharged = 0;
      for (const entry of ledger.nonces.values()) {
        if (entry.state === "settled") perNonceCharged += entry.price;
      }
      assert.equal(ledger.settledTotal, perNonceCharged, "no nonce charged twice");
    },
  ), { seed: seedBase + 1, numRuns: RUNS });
});

test("P3 single-use: at most one in-flight authorization; the first settle revokes the grant", async t => {
  const db = database(t);
  const nowMs = Date.now();
  await fc.assert(fc.property(
    grantParamsArb,
    opsArb(false),
    (params, ops) => {
      drive(db, ROOM_ID, [makeLedger(freshAgent(), params.cap, params.perTx, true)], null, ops, nowMs);
    },
  ), { seed: seedBase + 2, numRuns: RUNS });
});

test("P4 per-agent isolation: interleaved charges for two agents never leak across grants", async t => {
  const db = database(t);
  const nowMs = Date.now();
  await fc.assert(fc.property(
    grantParamsArb,
    grantParamsArb,
    opsArb(true),
    (paramsA, paramsB, ops) => {
      drive(db, ROOM_ID, [
        makeLedger(freshAgent(), paramsA.cap, paramsA.perTx, false),
        makeLedger(freshAgent(), paramsB.cap, paramsB.perTx, false),
      ], null, ops, nowMs);
    },
  ), { seed: seedBase + 3, numRuns: RUNS });
});

test("P5 room-allowance nesting: reservations never exceed the allowance headroom; outcomes match the model", async t => {
  const db = database(t);
  const nowMs = Date.now();
  const roomArb = fc.integer({ min: 0, max: 300 }).chain(allowance =>
    fc.record({
      allowance: fc.constant(allowance),
      committed: fc.integer({ min: 0, max: allowance }),
    }));
  await fc.assert(fc.property(
    grantParamsArb,
    roomArb,
    opsArb(false),
    (params, room, ops) => {
      drive(db, freshRoom(), [makeLedger(freshAgent(), params.cap, params.perTx, false)], room, ops, nowMs);
    },
  ), { seed: seedBase + 4, numRuns: RUNS });
});
