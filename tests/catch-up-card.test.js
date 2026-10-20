// Room Everywhere C1: the catch-up card. The preamble must stay byte-stable
// while the room moves, rolling data must be bounded, and the route must use
// the room read chain and stay read-only.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCatchUpCard, liveClaims, readCatchUp, CATCH_UP_ROUTES, CATCH_UP_MAX_BYTES } from "../server/routes/catch-up.mjs";

const now = Date.parse("2026-10-20T04:00:00Z");
const digest = (through, extra = {}) => ({
  viewerId: "m1", since: 0, through, context: { context_version: "cv1" },
  decisions: [{ seq: 3, type: "decision.recorded" }], attention: [{ kind: "ask", seq: 4, id: "a1", summary: "review?" }],
  messages: [{ seq: through, id: "x", actorId: "m2", summary: "hi" }], actionableNow: { total: 1, byKind: { ask: 1 } }, ...extra,
});
const claims = [
  { id: "c1", state: "claimed", owner: "m2", files: ["a", "b", "c", "d", "e", "f"], leaseExpiresAt: "2026-10-20T05:00:00Z" },
  { id: "c2", state: "in_progress", owner: "m3", files: ["z"], leaseExpiresAt: "2026-10-20T03:00:00Z" },
  { id: "c3", state: "unclaimed", owner: null, files: ["q"] },
];
const mentions = [{ messageEventId: "e1", state: "delivered", createdAt: "2026-10-20T03:59:00Z" }, { messageEventId: "e2", state: "acknowledged" }];

test("preamble is byte-stable while rolling data changes", () => {
  const a = buildCatchUpCard({ roomId: "r1", digest: digest(10), mentions, claims, nowMs: now });
  const b = buildCatchUpCard({ roomId: "r1", digest: digest(42), mentions: [], claims: [], nowMs: now + 60000 });
  assert.equal(JSON.stringify(a.preamble), JSON.stringify(b.preamble));
  assert.notEqual(JSON.stringify(a.rolling), JSON.stringify(b.rolling));
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(JSON.stringify(a.preamble)));
});

test("rolling carries decisions, asks, live claims and unread mentions", () => {
  const card = buildCatchUpCard({ roomId: "r1", digest: digest(10), mentions, claims, nowMs: now });
  assert.equal(card.rolling.decisions.length, 1);
  assert.equal(card.rolling.openAsks[0].id, "a1");
  assert.deepEqual(card.rolling.liveClaims.map(c => c.id), ["c1"]);
  assert.equal(card.rolling.liveClaims[0].files.length, 5);
  assert.equal(card.rolling.liveClaims[0].filesOmitted, 1);
  assert.deepEqual(card.rolling.unreadMentions, [{ messageEventId: "e1", createdAt: "2026-10-20T03:59:00Z" }]);
  assert.equal(card.untrusted, true);
});

test("the card stays under the byte budget and counts what it shed", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ seq: i, id: `m${i}`, actorId: "m2", summary: "x".repeat(140) }));
  const card = buildCatchUpCard({ roomId: "r1", digest: digest(500, { messages: many }), mentions, claims, nowMs: now });
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= CATCH_UP_MAX_BYTES);
  assert.ok(card.rolling.truncated.recentMessages > 0);
});

test("liveClaims drops lapsed and unowned claims", () => {
  assert.deepEqual(liveClaims(claims, now).map(c => c.id), ["c1"]);
});

const ctxFor = ({ query = "", scopes = ["rooms:read"] } = {}) => {
  const calls = [];
  const ctx = {
    params: { roomId: "r1" }, req: {}, res: {}, url: new URL(`https://room.example/api/rooms/r1/catch-up${query}`),
    roomCredentials: () => ({ bearer: true, mode: "room", token: "tok" }),
    expectedBinding: () => "fence", accountBinding: () => null,
    roomAuth: () => ({ kind: "api-key", credentialScope: "room", credentialHash: "h", apiKeyScopes: scopes, member: { id: "m1" } }),
    rate: () => {},
    reject: (status, code) => { throw Object.assign(new Error(code), { status }); },
    json: (_res, status, body) => ({ status, body }),
    store: {
      now: () => now,
      roomDigest: (token, roomId, opts) => { calls.push(["digest", token, roomId, opts]); return digest(10); },
      listMentions: (token, roomId, opts, fence) => { calls.push(["mentions", opts, fence]); return { mentions }; },
      workClaims: { list: roomId => { calls.push(["claims", roomId]); return claims; } },
    },
  };
  return { ctx, calls };
};

test("route reads digest, mentions and claims with the caller's credential", () => {
  const { ctx, calls } = ctxFor({ query: "?since=7" });
  const { status, body } = readCatchUp(ctx);
  assert.equal(status, 200);
  assert.equal(body.schema, "project-room-catch-up/1");
  assert.deepEqual(calls[0], ["digest", "tok", "r1", { since: 7, expectedSessionBinding: "fence" }]);
  assert.deepEqual(calls[1], ["mentions", { state: "delivered" }, "fence"]);
  assert.deepEqual(calls[2], ["claims", "r1"]);
});

test("route refuses bad cursors and keys without rooms:read", () => {
  assert.throws(() => readCatchUp(ctxFor({ query: "?since=-1" }).ctx), /invalid_cursor/);
  assert.throws(() => readCatchUp(ctxFor({ query: "?x=1" }).ctx), /invalid_cursor/);
  assert.throws(() => readCatchUp(ctxFor({ scopes: ["rooms:write"] }).ctx), /insufficient_scope/);
});

test("route row is a read-only room GET", () => {
  const [row] = CATCH_UP_ROUTES;
  assert.equal(row.method, "GET");
  assert.equal(row.auth, "room");
  assert.deepEqual(row.events, []);
});

test("guide tells agents to read the full claims list when the card hides claims or files", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `k${i}`, state: "claimed", owner: "m2", files: Array.from({ length: 9 }, (_, j) => `f${i}-${j}`), leaseExpiresAt: "2026-10-20T05:00:00Z" }));
  const card = buildCatchUpCard({ roomId: "r1", digest: digest(10), mentions, claims: many, nowMs: now });
  assert.ok(card.rolling.liveClaimsTotal > card.rolling.liveClaims.length);
  assert.ok(card.rolling.liveClaims.every(c => c.filesOmitted === 4));
  assert.match(card.preamble.guide, /liveClaimsTotal is larger than the liveClaims shown, or a claim has filesOmitted/);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= CATCH_UP_MAX_BYTES);
});
