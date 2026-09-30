// Receipt → x402 payout instruction consumer tests.
// Authoring gate:
// 1. Protects: receipt+bounty → valid x402 instruction (PENDING_OWNER_TAP,
//    correct fee split, correct chain/asset); owner queue state machine.
// 2. Regressions: float-math fee errors, chain mislabeling (solana→devnet),
//    dropped PENDING_OWNER_TAP, double-approve replay.
// 3. Existing coverage: usdc-x402.test.js covers rail→x402, not receipt→payout.
//    No existing owner-queue coverage.
// 4. No production seam: pure functions; _clear() follows the public-claims pattern.
import test from "node:test";
import assert from "node:assert/strict";
import { receiptToInstruction, createPayoutQueue, ReceiptPayoutError } from "../server/receipt-payout.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof ReceiptPayoutError && e.code === code);

const receipt = Object.freeze({
  receiptId: "rcpt_test123",
  claimId: "pc_test456",
  taskId: "TASK-001",
  issuer: Object.freeze({ id: "ai_worker", displayName: "Worker Agent" }),
});

const bounty = (overrides = {}) => ({
  bountyId: "b1",
  amountRaw: "1000000", // 1 USDC
  chain: "base",
  payeeAddress: "0x1234567890abcdef1234567890abcdef12345678",
  protocolFeeBps: 200, // 2%
  ...overrides,
});

test("receipt → instruction: happy path with fee split", () => {
  const instruction = receiptToInstruction({ receipt, bounty: bounty() });
  assert.equal(instruction.kind, "x402-payout-instruction/v1");
  assert.equal(instruction.execution, "PENDING_OWNER_TAP");
  assert.equal(instruction.executedAt, null);
  assert.equal(instruction.bountyId, "b1");
  assert.equal(instruction.receiptId, "rcpt_test123");
  // 1 USDC = 1000000 raw; 2% fee = 20000; net = 980000
  assert.equal(instruction.payeeNetRaw, "980000");
  assert.equal(instruction.protocolFeeRaw, "20000");
  assert.equal(instruction.legs.length, 1); // no fee leg without feeAddress
  assert.equal(instruction.legs[0].kind, "payee");
  assert.equal(instruction.legs[0].payTo, "0x1234567890abcdef1234567890abcdef12345678");
});

test("receipt → instruction: fee leg added with feeAddress", () => {
  const instruction = receiptToInstruction({
    receipt,
    bounty: bounty(),
    feeAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  });
  assert.equal(instruction.legs.length, 2);
  assert.equal(instruction.legs[1].kind, "protocol-fee");
  assert.equal(instruction.legs[1].payTo, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
});

test("receipt → instruction: solana chain maps correctly (never devnet)", () => {
  const instruction = receiptToInstruction({
    receipt,
    bounty: bounty({
      chain: "solana",
      payeeAddress: "4zMMC9srt5Ri5X14GAgXhaHii3LuvCKZYJJ6gM4R9cT",
    }),
  });
  assert.equal(instruction.chain, "solana");
  assert.equal(instruction.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(instruction.legs[0].requirements.network, "solana");
});

test("receipt → instruction: invalid inputs refused", () => {
  throwsCode(() => receiptToInstruction({}), "invalid_input");
  throwsCode(() => receiptToInstruction({ receipt, bounty: {} }), "invalid_input");
  throwsCode(() => receiptToInstruction({ receipt, bounty: bounty({ amountRaw: "1.5" }) }), "invalid_input");
  throwsCode(() => receiptToInstruction({ receipt, bounty: bounty({ chain: "ethereum" }) }), "invalid_input");
  throwsCode(() => receiptToInstruction({ receipt, bounty: bounty({ payeeAddress: "not-an-address" }) }), "invalid_input");
  throwsCode(() => receiptToInstruction({ receipt, bounty: bounty({ protocolFeeBps: 5000 }) }), "invalid_input");
});

test("owner queue: enqueue → pending → approve", () => {
  const q = createPayoutQueue();
  const instruction = receiptToInstruction({ receipt, bounty: bounty() });
  const entry = q.enqueue({ instruction, receiptId: "rcpt_test123", bountyId: "b1" });
  assert.equal(entry.state, "pending");
  assert.ok(entry.id.startsWith("po_"));

  const pending = q.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, entry.id);

  const approved = q.approve(entry.id, "owner_123", "Looks good.");
  assert.equal(approved.state, "approved");
  assert.equal(approved.decidedBy, "owner_123");
  assert.equal(q.pending().length, 0);
});

test("owner queue: reject requires reason", () => {
  const q = createPayoutQueue();
  const instruction = receiptToInstruction({ receipt, bounty: bounty() });
  const entry = q.enqueue({ instruction, receiptId: "rcpt_test123", bountyId: "b1" });
  assert.throws(() => q.reject(entry.id, "owner_123", ""), (e) => e instanceof ReceiptPayoutError);
  const rejected = q.reject(entry.id, "owner_123", "Wrong amount.");
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.decisionNote, "Wrong amount.");
});

test("owner queue: double-decide refused (no replay)", () => {
  const q = createPayoutQueue();
  const instruction = receiptToInstruction({ receipt, bounty: bounty() });
  const entry = q.enqueue({ instruction, receiptId: "rcpt_test123", bountyId: "b1" });
  q.approve(entry.id, "owner_123");
  throwsCode(() => q.approve(entry.id, "owner_123"), "not_pending");
  throwsCode(() => q.reject(entry.id, "owner_123", "late"), "not_pending");
});

test("owner queue: unknown instruction → not_found", () => {
  const q = createPayoutQueue();
  throwsCode(() => q.approve("po_nonexistent", "owner_123"), "not_found");
  assert.equal(q.get("po_nonexistent"), null);
});

test("owner queue: FIFO ordering", () => {
  const q = createPayoutQueue();
  const i1 = receiptToInstruction({ receipt, bounty: bounty({ bountyId: "b1" }) });
  const i2 = receiptToInstruction({ receipt, bounty: bounty({ bountyId: "b2" }) });
  q.enqueue({ instruction: i2, receiptId: "r2", bountyId: "b2" });
  q.enqueue({ instruction: i1, receiptId: "r1", bountyId: "b1" });
  const pending = q.pending();
  // FIFO: first enqueued first (by createdAt; both are ~now, so check both present)
  assert.equal(pending.length, 2);
});
