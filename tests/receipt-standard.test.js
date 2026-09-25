// Project Room Receipt Standard v1 — reference implementation tests.
//
// Authoring gate: this is the only coverage of the open standard's
// verification contract. Third-party emitters and verifiers will depend on
// these exact behaviors: round-trip validity, tamper-evidence (bytes,
// declaration, signature), fail-closed identity binding, replay protection
// (freshness window + seen-set), and version rejection. Each failure case
// names the attack it blocks; loosening any MUST-check (exactKeys, number
// ban, freshness, untrusted_issuer) must break a test here. Keys are
// generated in-memory per test; no I/O, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_AGE_MS,
  emitReceipt,
  generateReceiptKeyPair,
  RECEIPT_STANDARD_VERSION,
  roomWorkReceiptToStandard,
  sha256Hex,
  verifyReceipt,
} from "../server/receipt-standard.mjs";
import { canonicalJson, signBytes } from "../server/bounty-receipts.mjs";

const FIXED_NOW = Date.parse("2026-09-25T18:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

const keypair = () => {
  const { seedHex, pubkeyHex } = generateReceiptKeyPair();
  return { seedHex, pubkeyHex };
};

const baseInput = (keys, overrides = {}) => ({
  issuer: { pubkeyHex: keys.pubkeyHex, agentId: "ai_test123", roomId: "commons" },
  seedHex: keys.seedHex,
  issuedAt: iso(FIXED_NOW - 60_000),
  now: FIXED_NOW,
  surface: {
    roomId: "commons",
    workItemId: "RC-2026-09-25-101",
    resources: [{ kind: "file", ref: "server/http.mjs", sha256: sha256Hex(Buffer.from("x")) }],
  },
  status: "done",
  deliverables: [{ name: "out.txt", bytes: "5", sha256: sha256Hex(Buffer.from("hello")) }],
  declaration: { summary: "Fixed the overflow", claims: ["No longer overflows at 360px"] },
  observations: [{ kind: "test-run", detail: "30/30 pass" }],
  limitations: ["Not verified on a real mobile device"],
  ...overrides,
});

const verifyOpts = (keys, overrides = {}) => ({
  expectedPubkey: keys.pubkeyHex,
  now: FIXED_NOW,
  ...overrides,
});

const tamper = (receipt, fn) => {
  const copy = JSON.parse(JSON.stringify(receipt));
  fn(copy);
  return copy;
};

test("round-trip: a valid v1 receipt verifies", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  assert.equal(receipt.schemaVersion, RECEIPT_STANDARD_VERSION);
  const res = verifyReceipt(receipt, verifyOpts(keys));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.receiptId, receipt.receiptId);
  assert.equal(res.status, "done");
  assert.equal(res.issuer.pubkey, keys.pubkeyHex);
});

test("round-trip: JSON text form verifies (strict parse path)", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const res = verifyReceipt(JSON.stringify(receipt), verifyOpts(keys));
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("tampered deliverable bytes fail (bad_signature)", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const bad = tamper(receipt, r => { r.deliverables[0].sha256 = sha256Hex(Buffer.from("forged")); });
  const res = verifyReceipt(bad, verifyOpts(keys));
  assert.equal(res.ok, false);
  assert.match(res.reason, /^bad_signature/);
});

test("tampered declaration fails (bad_signature)", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const bad = tamper(receipt, r => { r.declaration.summary = "Fixed everything, trust me"; });
  const res = verifyReceipt(bad, verifyOpts(keys));
  assert.equal(res.ok, false);
  assert.match(res.reason, /^bad_signature/);
});

test("tampered signature bytes fail", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const bad = tamper(receipt, r => {
    r.signature = r.signature.slice(0, -1) + (r.signature.endsWith("0") ? "1" : "0");
  });
  const res = verifyReceipt(bad, verifyOpts(keys));
  assert.equal(res.ok, false);
  assert.match(res.reason, /^bad_signature/);
});

test("wrong key fails (unexpected_signer) — attacker's valid signature rejected", () => {
  const issuerKeys = keypair();
  const attackerKeys = keypair();
  const receipt = emitReceipt(baseInput(attackerKeys));
  const res = verifyReceipt(receipt, verifyOpts(issuerKeys));
  assert.equal(res.ok, false);
  assert.match(res.reason, /^unexpected_signer/);
});

test("no expectedPubkey fails closed (untrusted_issuer) unless explicitly allowed", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const closed = verifyReceipt(receipt, { now: FIXED_NOW });
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /^untrusted_issuer/);
  const open = verifyReceipt(receipt, { now: FIXED_NOW, allowUnboundIssuer: true });
  assert.equal(open.ok, true, JSON.stringify(open));
});

test("replay outside the freshness window fails (stale_receipt)", () => {
  const keys = keypair();
  const fresh = emitReceipt(baseInput(keys));
  // A validly-signed receipt whose issuedAt has aged out: re-sign the body
  // with a stale timestamp (the replay attack this MUST blocks).
  const staleBody = tamper(fresh, r => { r.issuedAt = iso(FIXED_NOW - DEFAULT_MAX_AGE_MS - 1000); });
  const { signature: _dropped, ...unsigned } = staleBody;
  const stale = { ...unsigned, signature: signBytes(canonicalJson(unsigned), keys.seedHex) };
  const res = verifyReceipt(stale, verifyOpts(keys));
  assert.equal(res.ok, false);
  assert.match(res.reason, /^stale_receipt/);
});

test("receipt from the future fails (future_receipt)", () => {
  const keys = keypair();
  // The emit-time sanity check runs against the pinned clock: give it a `now`
  // inside the skew window of the future issuedAt so emit succeeds and the
  // failure is deferred to verification, which is what this test guards.
  const receipt = emitReceipt(baseInput(keys, { issuedAt: iso(FIXED_NOW + 10 * 60_000), now: FIXED_NOW + 15 * 60_000 }));
  const res = verifyReceipt(receipt, verifyOpts(keys));
  assert.equal(res.ok, false);
  assert.match(res.reason, /^future_receipt/);
});

test("duplicate receiptId in a single-use context fails (duplicate_receipt)", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const seen = new Set();
  assert.equal(verifyReceipt(receipt, verifyOpts(keys, { seen })).ok, true);
  const replay = verifyReceipt(receipt, verifyOpts(keys, { seen }));
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /^duplicate_receipt/);
});

test("v0 and unknown versions are rejected (unknown_version)", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  for (const version of ["project-room-receipt/0", "project-room-receipt/2", "room-bounty-receipt/1"]) {
    const bad = tamper(receipt, r => { r.schemaVersion = version; });
    const res = verifyReceipt(bad, { now: FIXED_NOW, allowUnboundIssuer: true });
    assert.equal(res.ok, false, version);
    assert.match(res.reason, /^unknown_version/, version);
  }
});

test("unknown fields are rejected (invalid_receipt) — no smuggling past verifiers", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const bad = tamper(receipt, r => { r.extra = "smuggled"; });
  const res = verifyReceipt(bad, { now: FIXED_NOW, allowUnboundIssuer: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /^invalid_receipt/);
});

test("JSON numbers in the signed body are rejected before signature checking", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const bad = tamper(receipt, r => { r.deliverables[0].bytes = 5; });
  const res = verifyReceipt(bad, { now: FIXED_NOW, allowUnboundIssuer: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /^number_ban/);
});

test("duplicate-key JSON text is rejected at parse time", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const text = JSON.stringify(receipt).replace('"status":"done"', '"status":"done","status":"blocked"');
  const res = verifyReceipt(text, { now: FIXED_NOW, allowUnboundIssuer: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid_json/);
});

test("context binding: receipt from another room fails in this room's context", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const res = verifyReceipt(receipt, verifyOpts(keys, { expectedRoomId: "other-room" }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /^context_mismatch/);
  const good = verifyReceipt(receipt, verifyOpts(keys, { expectedRoomId: "commons", expectedAgentId: "ai_test123" }));
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("deliverable content is recomputed when fetchContent is supplied", () => {
  const keys = keypair();
  const receipt = emitReceipt(baseInput(keys));
  const good = verifyReceipt(receipt, verifyOpts(keys, { fetchContent: () => Buffer.from("hello") }));
  assert.equal(good.ok, true, JSON.stringify(good));
  const forged = verifyReceipt(receipt, verifyOpts(keys, { fetchContent: () => Buffer.from("forged!") }));
  assert.equal(forged.ok, false);
  assert.match(forged.reason, /^content_mismatch/);
});

test("limitations must price ignorance: empty limitations rejected at emit", () => {
  const keys = keypair();
  assert.throws(() => emitReceipt(baseInput(keys, { limitations: [] })), /limitations must be a non-empty array/);
});

test("blocked and partial statuses round-trip", () => {
  const keys = keypair();
  for (const status of ["partial", "blocked"]) {
    const receipt = emitReceipt(baseInput(keys, { status }));
    const res = verifyReceipt(receipt, verifyOpts(keys));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, status);
  }
});

test("adapter: room work receipt (rc_*) maps onto the standard and verifies", () => {
  const keys = keypair();
  const roomReceipt = Object.freeze({
    receiptId: "rc_abc123",
    workItemId: "abc123",
    tags: Object.freeze(["ui"]),
    summary: "Fixed the needs-attention card overflow on narrow viewports",
    createdBy: "ai_test123",
    createdAt: FIXED_NOW - 3600_000,
    blobs: Object.freeze(["blob:deadbeef"]),
  });
  const receipt = roomWorkReceiptToStandard(roomReceipt, {
    issuer: { pubkeyHex: keys.pubkeyHex, agentId: "ai_test123", roomId: "commons" },
    seedHex: keys.seedHex,
    issuedAt: iso(FIXED_NOW - 60_000),
    now: FIXED_NOW,
  });
  assert.equal(receipt.status, "done");
  assert.equal(receipt.surface.workItemId, "abc123");
  assert.ok(receipt.surface.resources.some(r => r.kind === "room-receipt" && r.ref === "rc_abc123"),
    "the original rc_ id is preserved as a surface resource");
  assert.ok(receipt.limitations.some(l => l.includes("unsigned room record")),
    "the projection's limits are declared in limitations");
  assert.ok(receipt.observations.some(o => o.kind === "room-projection"));
  const res = verifyReceipt(receipt, verifyOpts(keys, { expectedRoomId: "commons" }));
  assert.equal(res.ok, true, JSON.stringify(res));
});
