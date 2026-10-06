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
function fakeCtx({ member = { id: "ava", displayName: "Ava", kind: "human" }, roomId = "commons", bearer = false, authExtra = {}, protectWrite = () => {} } = {}) {
  const rated = [];
  const protectedWrites = [];
  let captured = null;
  const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
  return {
    captured: () => captured,
    rated,
    req: { method: "POST", headers: {} },
    res: {},
    url: new URL(`https://room.example/api/rooms/${roomId}/typing`),
    params: { roomId },
    roomCredentials: () => ({ token: "tok", bearer, mode: "room" }),
    expectedBinding: () => null,
    accountBinding: () => { throw new Error("not account mode"); },
    roomAuth: () => (member ? { member, credentialHash: "hash-ava", kind: "session", ...authExtra } : { member: null }),
    protectWrite: (req, auth, isBearer) => { protectedWrites.push(isBearer); protectWrite(req, auth, isBearer); },
    protectedWrites,
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
  assert.deepEqual(ctx.rated, [["write:hash-ava", 60], ["typing:hash-ava", 120]]);
});

test("missing room membership is rejected before any beat is recorded", async t => {
  t.after(() => typingBeats.clear());
  const ctx = fakeCtx({ member: null });
  const err = await postTypingBeat(ctx).then(() => null, e => e);
  assert.ok(err, "expected a rejection");
  assert.equal(err.status, 401);
  assert.equal(currentTypists(typingBeats, "commons", "someone-else").length, 0);
});

// Instinct-3 review of #1545 (muse-room 3509): a typing beat takes the room
// write chain. Each case below recorded a beat before the fix.
const refused = async ctx => {
  const err = await postTypingBeat(ctx).then(() => null, e => e);
  assert.ok(err, "expected a rejection");
  assert.equal(currentTypists(typingBeats, "commons", "someone-else").length, 0, "no beat recorded");
  return err;
};

test("a bearer account session (not a room credential) is refused", async t => {
  t.after(() => typingBeats.clear());
  const err = await refused(fakeCtx({ bearer: true, authExtra: { credentialScope: "account-session" } }));
  assert.equal(err.status, 403);
});

test("an API key without rooms:write cannot post typing", async t => {
  t.after(() => typingBeats.clear());
  const err = await refused(fakeCtx({ authExtra: { kind: "api-key", apiKeyScopes: ["rooms:read"] } }));
  assert.equal(err.status, 403);
  assert.equal(err.code, "insufficient_scope");
});

test("cookie writes go through protectWrite (CSRF/Origin) before any beat", async t => {
  t.after(() => typingBeats.clear());
  const csrf = () => { const e = new Error("Origin required"); e.status = 403; throw e; };
  const ctx = fakeCtx({ protectWrite: csrf });
  const err = await refused(ctx);
  assert.equal(err.status, 403);
  assert.deepEqual(ctx.protectedWrites, [false]);
});

test("an API key with rooms:write and a room bearer both still work", async t => {
  t.after(() => typingBeats.clear());
  const keyed = fakeCtx({ authExtra: { kind: "api-key", apiKeyScopes: ["rooms:write"] } });
  await postTypingBeat(keyed);
  assert.equal(keyed.captured().status, 200);
  const bearer = fakeCtx({ bearer: true, authExtra: { credentialScope: "room", kind: "access" } });
  await postTypingBeat(bearer);
  assert.equal(bearer.captured().status, 200);
});
