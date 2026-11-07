// Byte-identity vectors for both canonicalJson serializers (PERF-50 B3-a/B3-b).
//
// canonicalJson feeds receipt hashing and Ed25519 signing, so its output
// bytes are a correctness surface, not an implementation detail: the
// presort + JSON.stringify fast path in src/audit-receipts.mjs and the
// single-Buffer rebuild in server/bounty-receipts.mjs must reproduce the
// original recursive serializers byte-for-byte on every shape below —
// including the shapes a naive presort gets wrong (integer-like keys,
// sparse arrays, Dates, wrapper objects, prototype toJSON). The expected
// strings and SHA-256 digests were generated from the pre-change
// implementations; any future drift fails here before it can reach a hash.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson as canonicalStr } from "../src/audit-receipts.mjs";
import { canonicalJson as canonicalBuf } from "../server/bounty-receipts.mjs";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("string variant: exact bytes on the edge shapes", () => {
  assert.equal(canonicalStr({ b: 1, a: [3, 1, 2] }), '{"a":[3,1,2],"b":1}');
  assert.equal(canonicalStr({}), "{}");
  assert.equal(canonicalStr([]), "[]");
  assert.equal(canonicalStr(""), '""');
  assert.equal(canonicalStr(null), "null");
  assert.equal(canonicalStr(-0), "0");
  assert.equal(canonicalStr(1e21), "1e+21");
  assert.equal(canonicalStr(1e-7), "1e-7");
  // Integer-like keys sort as UTF-16 strings ("10" < "2"), not numerically.
  assert.equal(canonicalStr({ "10": "x", "2": "y", a: 1, "1": "z" }), '{"1":"z","10":"x","2":"y","a":1}');
  assert.equal(canonicalStr({ outer: { "10": 1, "9": 2 } }), '{"outer":{"10":1,"9":2}}');
  // Sparse arrays keep the recursive form's empty slots.
  assert.equal(canonicalStr([1, , 3]), "[1,,3]");
  assert.equal(canonicalStr([, ,]), "[,]");
  // Dates serialize as ISO strings, at any depth.
  assert.equal(canonicalStr(new Date(0)), '"1970-01-01T00:00:00.000Z"');
  assert.equal(canonicalStr({ d: new Date(0) }), '{"d":"1970-01-01T00:00:00.000Z"}');
  // Unicode keys in UTF-16 code-unit order; escapes match JSON.stringify.
  assert.equal(canonicalStr({ "é": 1, a: 2, "😀": 3, Z: 4 }), '{"Z":4,"a":2,"é":1,"😀":3}');
  assert.equal(canonicalStr({ s: "q\" b\\ \t\n\u0001" }), '{"s":"q\\" b\\\\ \\t\\n\\u0001"}');
  assert.equal(canonicalStr("bad \ud800 wolf"), '"bad \\ud800 wolf"');
  // Non-plain objects keep the old Object.keys treatment.
  assert.equal(canonicalStr(new Map([["a", 1]])), "{}");
  assert.equal(canonicalStr(new String("hi")), '{"0":"h","1":"i"}');
  assert.equal(canonicalStr(new Number(5)), "{}");
  const protoToJSON = Object.assign(Object.create({ toJSON() { return { x: 9 }; } }), { a: 1 });
  assert.equal(canonicalStr(protoToJSON), '{"a":1}');
});

test("string variant: the stricter-than-JSON contract still throws", () => {
  for (const bad of [undefined, () => {}, 10n, Symbol("s"), NaN, Infinity])
    assert.throws(() => canonicalStr(bad), TypeError);
  assert.throws(() => canonicalStr({ a: undefined }), TypeError);
  assert.throws(() => canonicalStr([undefined]), TypeError);
  assert.throws(() => canonicalStr({ a: () => {} }), TypeError);
  assert.throws(() => canonicalStr({ a: 1n }), TypeError);
  assert.throws(() => canonicalStr({ a: -Infinity }), TypeError);
  assert.throws(() => canonicalStr(new Date(NaN)), RangeError);
});

test("string variant: caller objects are never reordered", () => {
  const victim = { z: 1, a: { y: 2, b: 3 }, m: [{ q: 1, a: 2 }] };
  canonicalStr(victim);
  assert.deepEqual(Object.keys(victim), ["z", "a", "m"]);
  assert.deepEqual(Object.keys(victim.a), ["y", "b"]);
  assert.deepEqual(Object.keys(victim.m[0]), ["q", "a"]);
});

// Snapshot shapes at B3's scales, keys inserted in wire (unsorted) order;
// digests pinned from the pre-change serializer.
function messageRecord(i) {
  return {
    seq: 1000 + i,
    id: `msg_${(0x9e3779b1 * (i + 1) >>> 0).toString(16).padStart(8, "0")}`,
    body: `Message ${i}: discussing the landing queue, the settle pass and the next checkpoint for the room`,
    roomId: "room_9f2c41ab",
    authorId: `agent_${i % 7}`,
    at: "2026-10-27T17:42:11.123Z",
    kind: "message",
    meta: { edited: false, replyTo: null, tags: ["queue", "settle"] },
  };
}
function snapshot(n) {
  const messages = [];
  for (let i = 0; i < n; i++) messages.push(messageRecord(i));
  return {
    room: { name: "Project Room", id: "room_9f2c41ab", createdAt: "2026-01-04T00:00:00.000Z" },
    messages,
    members: { agent_jill_2: { kind: "agent", joinedSeq: 12 }, human_john: { kind: "human", joinedSeq: 1 } },
    workItems: { wi_7d3f91c2: { state: "open", title: "Checkpoint writer", assignee: "agent_jill_2" } },
    seq: 1000 + n,
  };
}

test("string variant: snapshot digests are unchanged at 7 KB / 90 KB / 900 KB", () => {
  assert.equal(sha256(canonicalStr(snapshot(22))), "d4bd74e6e2b41c9993ee62a965bf42b5c4a6dc23577bb3c73889ab6a095884e4");
  assert.equal(sha256(canonicalStr(snapshot(300))), "99dd11e0b06d600e5e42d33f1d102dba7f633b048e25a5619384587cf8c3f233");
  assert.equal(sha256(canonicalStr(snapshot(3000))), "6b4dbfbed494e7cd61bdf26182533de7673c8951eee11996ffb0ebcdb7f43f81");
});

const MONEY = {
  type: "payout-released",
  schemaVersion: "room-bounty-receipt/1",
  roomId: "room_9f2c41ab",
  receiptId: "room-bounty-receipt:pr:0123456789abcdef0123456789abcdef",
  payload: { paidTo: "agent_jill_2", netAmountMillis: "12375", grossAmountMillis: "12500", feeAmountMillis: "125" },
  lotId: "lot_0123456789abcdef",
  amountMillis: "12375",
};
const MONEY_CANONICAL = '{"amountMillis":"12375","lotId":"lot_0123456789abcdef","payload":{"feeAmountMillis":"125","grossAmountMillis":"12500","netAmountMillis":"12375","paidTo":"agent_jill_2"},"receiptId":"room-bounty-receipt:pr:0123456789abcdef0123456789abcdef","roomId":"room_9f2c41ab","schemaVersion":"room-bounty-receipt/1","type":"payout-released"}';

test("both variants agree byte-for-byte on the money shape", () => {
  assert.equal(canonicalStr(MONEY), MONEY_CANONICAL);
  assert.equal(canonicalBuf(MONEY).toString("utf8"), MONEY_CANONICAL);
  assert.equal(sha256(canonicalBuf(MONEY).toString("utf8")), "4baa3c936f8a443a67dac74665dcd0d76f13c626337094af48b06441a74367d0");
});

test("buffer variant: exact bytes, escape discipline and the number ban", () => {
  assert.ok(Buffer.isBuffer(canonicalBuf(MONEY)));
  assert.equal(canonicalBuf({ z: ["a", "b"], a: { deep: "x" } }).toString("utf8"), '{"a":{"deep":"x"},"z":["a","b"]}');
  assert.equal(canonicalBuf({ "10": "x", "2": "y", a: "z" }).toString("utf8"), '{"10":"x","2":"y","a":"z"}');
  // Only the dasha escapes: " \ and control characters; never / or non-ASCII.
  assert.equal(canonicalBuf({ s: "a/bé\u0001" }).toString("utf8"), '{"s":"a/bé\\u0001"}');
  assert.equal(canonicalBuf({ s: "bad \ud800 wolf" }).toString("utf8"), '{"s":"bad � wolf"}');
  assert.equal(canonicalBuf({ d: new Date(0) }).toString("utf8"), '{"d":{}}');
  for (const bad of [5, { a: 1 }, ["1", 2], 10n, undefined, { a: undefined }, () => {}])
    assert.throws(() => canonicalBuf(bad));
  assert.throws(() => canonicalBuf({ a: 1 }), /number_ban|forbidden/i);
});
