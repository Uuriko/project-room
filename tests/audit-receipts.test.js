// F020: hash-chained signed audit receipts tests.
// Pure logic tests over the module's own API: chains build and verify,
// every tamper class is caught at the right place, and canonical JSON is
// key-order independent.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS_PREV_HASH,
  canonicalJson,
  issueReceipt,
  verifyReceipt,
  verifyChain
} from "../src/audit-receipts.mjs";

const KEY = "test-signing-key-2026-09-16";
const WRONG_KEY = "a-different-signing-key";

// F004 audit-entry shape: { sequence, event }, event = { id, type, roomId,
// actorId, at, data }. The receipts module never redefines this shape.
const makeEntry = (n, overrides = {}) => ({
  sequence: n,
  event: {
    id: `e_${n}`,
    type: "message.posted",
    roomId: "room_1",
    actorId: "m_avery",
    at: `2026-09-16T00:0${n}:21.000Z`,
    data: { messageId: `m_${n}` },
    ...overrides
  }
});

const buildChain = (n, key = KEY) => {
  const receipts = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    prev = issueReceipt(prev, makeEntry(i), key, `2026-09-16T00:1${i}:00.000Z`);
    receipts.push(prev);
  }
  return receipts;
};

test("chain of N receipts builds and fully verifies", () => {
  const receipts = buildChain(10);
  assert.equal(receipts.length, 10);
  assert.equal(verifyChain(receipts, KEY), -1);
  receipts.forEach((r, i) => {
    const prevHash = i === 0 ? GENESIS_PREV_HASH : receipts[i - 1].hash;
    assert.equal(r.seq, i);
    assert.equal(verifyReceipt(r, prevHash, KEY), true);
  });
});

test("empty chain verifies vacuously", () => {
  assert.equal(verifyChain([], KEY), -1);
});

test("genesis receipt has the documented shape", () => {
  const r = issueReceipt(null, makeEntry(0), KEY, "2026-09-16T00:00:00.000Z");
  assert.equal(r.seq, 0);
  assert.equal(r.prevHash, "0".repeat(64));
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.match(r.signature, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.entry, makeEntry(0));
  assert.equal(r.timestamp, "2026-09-16T00:00:00.000Z");
  assert.equal(verifyReceipt(r, GENESIS_PREV_HASH, KEY), true);
  assert.equal(verifyChain([r], KEY), -1);
});

test("tampered entry content fails verification at that receipt", () => {
  const receipts = buildChain(5);
  const tampered = structuredClone(receipts[2]);
  tampered.entry.event.data.messageId = "m_attacker";
  assert.equal(verifyReceipt(tampered, receipts[1].hash, KEY), false);
  const chain = receipts.map((r, i) => (i === 2 ? tampered : r));
  assert.equal(verifyChain(chain, KEY), 2);
});

test("tampered timestamp fails verification", () => {
  const receipts = buildChain(3);
  const tampered = structuredClone(receipts[1]);
  tampered.timestamp = "2026-09-16T23:59:59.000Z";
  assert.equal(verifyReceipt(tampered, receipts[0].hash, KEY), false);
  const chain = receipts.map((r, i) => (i === 1 ? tampered : r));
  assert.equal(verifyChain(chain, KEY), 1);
});

test("tampered prevHash breaks the chain at the right index", () => {
  const receipts = buildChain(5);
  const tampered = structuredClone(receipts[3]);
  tampered.prevHash = "ab".repeat(32);
  assert.equal(verifyReceipt(tampered, receipts[2].hash, KEY), false);
  const chain = receipts.map((r, i) => (i === 3 ? tampered : r));
  assert.equal(verifyChain(chain, KEY), 3);
});

test("swapped order is caught by the chain (seq + link continuity)", () => {
  const receipts = buildChain(4);
  const swapped = [receipts[0], receipts[2], receipts[1], receipts[3]];
  assert.equal(verifyChain(swapped, KEY), 1);
});

test("wrong signing key fails the signature check", () => {
  const receipts = buildChain(4);
  assert.equal(verifyChain(receipts, WRONG_KEY), 0);
  assert.equal(verifyReceipt(receipts[2], receipts[1].hash, WRONG_KEY), false);
  assert.equal(verifyReceipt(receipts[2], receipts[1].hash, KEY), true);
});

test("tampered signature fails verification", () => {
  const receipts = buildChain(2);
  const tampered = structuredClone(receipts[1]);
  tampered.signature = "ff".repeat(32);
  assert.equal(verifyReceipt(tampered, receipts[0].hash, KEY), false);
  const chain = receipts.map((r, i) => (i === 1 ? tampered : r));
  assert.equal(verifyChain(chain, KEY), 1);
});

test("non-genesis first receipt fails the chain at index 0", () => {
  const receipts = buildChain(3);
  assert.equal(verifyChain(receipts.slice(1), KEY), 0);
});

test("canonical JSON is key-order independent", () => {
  const a = { sequence: 1, event: { type: "message.posted", id: "e_1", data: { y: 2, x: 1 }, at: "t" } };
  const b = { event: { data: { x: 1, y: 2 }, at: "t", id: "e_1", type: "message.posted" }, sequence: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  const h1 = issueReceipt(null, a, KEY, "2026-09-16T00:00:00.000Z");
  const h2 = issueReceipt(null, b, KEY, "2026-09-16T00:00:00.000Z");
  assert.equal(h1.hash, h2.hash);
  assert.equal(h1.signature, h2.signature);
});

test("canonical JSON sorts nested keys and preserves array order", () => {
  assert.equal(canonicalJson({ b: 1, a: [3, 1, 2] }), '{"a":[3,1,2],"b":1}');
  assert.equal(canonicalJson({ z: { q: 1, p: 0 }, a: null }), '{"a":null,"z":{"p":0,"q":1}}');
});

test("canonical JSON rejects non-serializable values", () => {
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson({ a: () => {} }), TypeError);
  assert.throws(() => canonicalJson({ a: 1n }), TypeError);
});

test("issueReceipt validates its inputs", () => {
  assert.throws(() => issueReceipt(null, null, KEY), TypeError);
  assert.throws(() => issueReceipt(null, makeEntry(0), ""), TypeError);
  assert.throws(() => issueReceipt(null, makeEntry(0), 42), TypeError);
});

test("issueReceipt accepts a Uint8Array key", () => {
  const key = Buffer.from(KEY, "utf8");
  const r = issueReceipt(null, makeEntry(0), key, "2026-09-16T00:00:00.000Z");
  assert.equal(verifyReceipt(r, GENESIS_PREV_HASH, KEY), true);
  assert.equal(verifyReceipt(r, GENESIS_PREV_HASH, key), true);
});

test("issueReceipt defaults the timestamp to a current ISO instant", () => {
  const before = Date.now();
  const r = issueReceipt(null, makeEntry(0), KEY);
  const after = Date.now();
  const ts = Date.parse(r.timestamp);
  assert.ok(ts >= before && ts <= after, "timestamp should be within the test window");
  assert.equal(verifyChain([r], KEY), -1);
});

test("verifyChain is defensive against malformed inputs", () => {
  assert.equal(verifyChain(null, KEY), 0);
  assert.equal(verifyChain([null], KEY), 0);
  assert.equal(verifyChain([undefined, ...buildChain(2)], KEY), 0);
});

test("timing-safe comparison does not accept prefix-forged values", () => {
  const receipts = buildChain(2);
  const tampered = structuredClone(receipts[1]);
  tampered.signature = tampered.signature.slice(0, 32); // not 64 hex chars
  assert.equal(verifyReceipt(tampered, receipts[0].hash, KEY), false);
});
