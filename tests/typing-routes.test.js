// Transport boundary for POST /api/rooms/{roomId}/typing
// (server/routes/typing.mjs, postTypingBeat): stable status codes, room
// membership requirement, and the heartbeat contract. The pure heartbeat
// mechanics live in tests/typing.test.js and are never re-asserted here.
// postTypingBeat is the real boundary (used by dispatchRoute), so no
// test-only seam is involved.

import test from "node:test";
import assert from "node:assert/strict";
import { postTypingBeat } from "../server/routes/typing.mjs";
import { typingBeats, currentTypists, TYPING_TTL_MS } from "../server/typing.mjs";

// Mirrors the repo's reject: throws, so the handler's flow control works.
function fakeCtx({ member = { id: "ava", displayName: "Ava", kind: "human" }, roomId = "commons" } = {}) {
  const rated = [];
  let captured = null;
  const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
  return {
    captured: () => captured,
    rated,
    req: { method: "POST", headers: {} },
    res: {},
    url: new URL(`https://room.example/api/rooms/${roomId}/typing`),
    params: { roomId },
    roomCredentials: () => ({ token: "tok", bearer: false, mode: "room" }),
    expectedBinding: () => null,
    accountBinding: () => { throw new Error("not account mode"); },
    roomAuth: () => (member ? { member, credentialHash: "hash-ava" } : { member: null }),
    rate: (key, max) => { rated.push([key, max]); },
    json: (_res, status, value) => { captured = { status, value }; return captured; },
    reject,
  };
}

test("POST with room membership records a beat and returns the TTL", async t => {
  t.after(() => typingBeats.clear());
  const ctx = fakeCtx();
  await postTypingBeat(ctx);
  assert.equal(ctx.captured().status, 200);
  assert.deepEqual(ctx.captured().value, { ok: true, ttlMs: TYPING_TTL_MS });
  const typists = currentTypists(typingBeats, "commons", "someone-else");
  assert.deepEqual(typists, [{ memberId: "ava", displayName: "Ava", kind: "human" }]);
});

test("heartbeat is rate-limited per credential", async t => {
  t.after(() => typingBeats.clear());
  const ctx = fakeCtx();
  await postTypingBeat(ctx);
  assert.deepEqual(ctx.rated, [["typing:hash-ava", 120]]);
});

test("missing room membership is rejected before any beat is recorded", async t => {
  t.after(() => typingBeats.clear());
  const ctx = fakeCtx({ member: null });
  const err = await postTypingBeat(ctx).then(() => null, e => e);
  assert.ok(err, "expected a rejection");
  assert.equal(err.status, 401);
  assert.equal(currentTypists(typingBeats, "commons", "someone-else").length, 0);
});
