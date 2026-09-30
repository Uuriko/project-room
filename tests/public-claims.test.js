// Public claim verb tests — John's "one public verb" directive (2026-09-30).
// Pure registry tests; no store, no HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicClaimRegistry, ClaimError } from "../server/public-claims.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => error instanceof ClaimError && error.code === code);

const claimant = { id: "ai_test123", displayName: "Test Agent" };
const other = { id: "ai_other456", displayName: "Other Agent" };

const makeClaim = (registry, overrides = {}) =>
  registry.create({
    taskId: "TASK-001",
    claimant,
    scope: { description: "Write a haiku", files: ["haiku.txt"] },
    ...overrides,
  });

test("create → heartbeat → complete is the happy path", () => {
  const r = createPublicClaimRegistry();
  const claim = makeClaim(r);
  assert.equal(claim.state, "active");
  assert.ok(claim.leaseExpiresAt > Date.now());
  assert.equal(claim.claimant.id, claimant.id);

  const beat = r.heartbeat(claim.id, claimant.id);
  assert.equal(beat.state, "active");

  const { claim: done, receipt } = r.complete(claim.id, claimant.id, {
    summary: "Wrote the haiku.",
    evidenceUrl: "https://example.com/haiku.txt",
  });
  assert.equal(done.state, "completed");
  assert.ok(done.receiptId);
  assert.equal(receipt.claimId, claim.id);
  assert.equal(receipt.taskId, "TASK-001");
  assert.ok(receipt.signatures.length === 1);
  assert.equal(receipt.signatures[0].algorithm, "Ed25519");
});

test("receipt verifies with the server public key", () => {
  const r = createPublicClaimRegistry();
  const claim = makeClaim(r);
  const { receipt } = r.complete(claim.id, claimant.id, { summary: "Done." });
  const { receipt: fetched, verified } = r.getReceipt(receipt.receiptId);
  assert.ok(fetched);
  assert.equal(fetched.receiptId, receipt.receiptId);
  assert.equal(verified, true);
});

test("duplicate task claim is refused while active", () => {
  const r = createPublicClaimRegistry();
  makeClaim(r);
  throwsCode(() => makeClaim(r), "claim_conflict");
});

test("expired claim auto-releases and frees the task", () => {
  const r = createPublicClaimRegistry();
  // Create with a lease that expires immediately (via manual tweak for test).
  const claim = r.create({
    taskId: "TASK-EXP",
    claimant,
    scope: { description: "Expiring" },
    leaseHours: 0.000001, // ~3.6ms
  });
  // Wait for expiry.
  const start = Date.now();
  while (Date.now() - start < 10) { /* busy wait */ }
  const fetched = r.get(claim.id);
  assert.equal(fetched.state, "expired");
  // Task slot is free — a new claim succeeds.
  const claim2 = r.create({
    taskId: "TASK-EXP",
    claimant: other,
    scope: { description: "Takeover" },
  });
  assert.equal(claim2.state, "active");
  assert.equal(claim2.claimant.id, other.id);
});

test("only the claimant can heartbeat, release, or complete", () => {
  const r = createPublicClaimRegistry();
  const claim = makeClaim(r);
  throwsCode(() => r.heartbeat(claim.id, other.id), "not_authorized");
  throwsCode(() => r.release(claim.id, other.id), "not_authorized");
  throwsCode(() => r.complete(claim.id, other.id, { summary: "Hijack" }), "not_authorized");
  // Original claimant still works.
  const released = r.release(claim.id, claimant.id, "Giving up.");
  assert.equal(released.state, "released");
});

test("completed claim cannot be heartbeat or completed again", () => {
  const r = createPublicClaimRegistry();
  const claim = makeClaim(r);
  r.complete(claim.id, claimant.id, { summary: "Done." });
  throwsCode(() => r.heartbeat(claim.id, claimant.id), "claim_not_active");
  throwsCode(() => r.complete(claim.id, claimant.id, { summary: "Again" }), "claim_not_active");
});

test("list returns only active claims, newest first", () => {
  const r = createPublicClaimRegistry();
  const c1 = makeClaim(r, { taskId: "TASK-A" });
  const c2 = makeClaim(r, { taskId: "TASK-B" });
  r.release(c1.id, claimant.id);
  const list = r.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c2.id);
});

test("invalid inputs are refused", () => {
  const r = createPublicClaimRegistry();
  throwsCode(() => r.create({ taskId: "", claimant, scope: {} }), "invalid_claim_input");
  throwsCode(() => r.create({ taskId: "X", claimant: {}, scope: {} }), "invalid_claim_input");
  throwsCode(() => r.create({ taskId: "X", claimant, scope: null }), "invalid_claim_input");
  throwsCode(() => r.create({ taskId: "X", claimant, scope: {}, leaseHours: 100 }), "invalid_claim_input");
  throwsCode(() => r.create({ taskId: "X", claimant, scope: {}, leaseHours: 0 }), "invalid_claim_input");
});

test("unknown claim and receipt return null", () => {
  const r = createPublicClaimRegistry();
  assert.equal(r.get("pc_nonexistent"), null);
  assert.equal(r.getReceipt("rcpt_nonexistent"), null);
});
