import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonical, digest } from "../server/recovery.mjs";

// #3483: auditRecovery's contents digest canonicalizes every table row.
// A sqlite BLOB cell arrives as a Uint8Array; the old canonical walked it
// with Object.keys, rendering ~1M numeric keys per MiB (~5,334 ms per 1 MiB
// BLOB row vs 46 ms for the same row with a text cell). canonical now
// renders bytes as a deterministic `blob:<sha256-of-bytes>` token. The
// digest value for BLOB-bearing tables changes with this fix — it is a
// verification receipt, not a wire format. Non-BLOB canonical output must
// not change, so non-attachment table digests do not move.

// The pre-#3483 canonical, kept here as the reference for non-BLOB values.
const referenceCanonical = value => Array.isArray(value) ? `[${value.map(referenceCanonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${referenceCanonical(value[key])}`).join(",")}}` : JSON.stringify(value);

test("canonical renders a Uint8Array as a blob:<sha256> byte token", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const expected = `blob:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(canonical(bytes), expected);
  // Buffer is a Uint8Array subclass; the same bytes render the same token.
  assert.equal(canonical(Buffer.from([0, 1, 2, 250, 255])), expected);
});

test("canonicalizing a 1 MiB Uint8Array row completes in under 50 ms", () => {
  const bytes = new Uint8Array(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const row = { room_id: "commons", id: "att-1", byte_length: bytes.length, bytes };
  const started = performance.now();
  const rendered = canonical(row);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `canonicalizing a 1 MiB BLOB row took ${elapsed.toFixed(1)} ms (was ~5,334 ms)`);
  assert.ok(rendered.length < 200, "the row canonical stays token-sized, not an ~11.9 MB numeric-key string");
});

test("BLOB digest is deterministic across runs and sensitive to one flipped byte", () => {
  const bytes = new Uint8Array(64 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  const again = new Uint8Array(bytes);
  assert.equal(canonical(again), canonical(bytes));
  assert.equal(digest([{ id: "att-1", bytes: again }]), digest([{ id: "att-1", bytes }]));
  const flipped = new Uint8Array(bytes);
  flipped[32768] ^= 0xff;
  assert.notEqual(canonical(flipped), canonical(bytes));
  assert.notEqual(digest([{ id: "att-1", bytes: flipped }]), digest([{ id: "att-1", bytes }]));
  assert.notEqual(digest([new Uint8Array([1, 2, 3])]), digest([new Uint8Array([1, 2, 3, 0])]),
    "a length change changes the digest too");
});

test("text, array and object canonical output is unchanged for non-BLOB values", () => {
  const battery = [
    null, true, false, 0, 1, -17, 3.25,
    "", "plain text", "blob:not-a-blob", "unicode café ☃ \"quoted\"",
    [], [1, 2, 3], ["a", null, true], [[1, [2]], { x: [] }],
    {}, { a: 1 }, { b: 2, a: 1 }, { z: [1, { y: "x" }], a: { nested: [true, null] } },
    { room_id: "commons", member_id: "owner", revision: 3, state: "active", due_at: 1760000000000 },
    ["commons", "owner", "work-1"],
  ];
  for (const value of battery) assert.equal(canonical(value), referenceCanonical(value));
  // A text cell whose content merely looks like a token cannot collide
  // with a real BLOB: text goes through JSON.stringify and keeps its quotes.
  const bytes = new Uint8Array([9, 8, 7]);
  assert.notEqual(canonical({ bytes: canonical(bytes) }), canonical({ bytes }));
});
