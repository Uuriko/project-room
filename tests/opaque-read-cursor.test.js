import test from "node:test";
import assert from "node:assert/strict";
import { opaqueReadCursor } from "../server/opaque-read-cursor.mjs";

test("opaque read cursor round-trips a value and hides it", () => {
  const cursor = opaqueReadCursor({});
  const value = { offset: 42, roomId: "r1" };
  const token = cursor.encode(value);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(token.includes("42"), false);
  assert.deepEqual(cursor.decode(token), value);
  assert.notEqual(cursor.encode(value), token, "fresh nonce per encode");
});

test("opaque read cursor rejects tokens from another store, tampered, or malformed", () => {
  const a = opaqueReadCursor({}), b = opaqueReadCursor({});
  const token = a.encode({ offset: 1 });
  assert.equal(b.decode(token), null);
  const flipped = (token[40] === "A" ? "B" : "A");
  assert.equal(a.decode(token.slice(0, 40) + flipped + token.slice(41)), null);
  for (const bad of [undefined, 7, "", "not base64!", "x".repeat(4097), token.slice(0, 20)]) assert.equal(a.decode(bad), null);
});
