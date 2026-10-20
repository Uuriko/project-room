import test from "node:test";
import assert from "node:assert/strict";
import { buildClaimMap, buildWorkReady, CLAIM_MAP_ROUTES } from "../server/routes/claim-map.mjs";

const now = Date.parse("2026-10-20T00:00:00Z");
const items = [
  { id: "a", state: "claimed", owner: "grok", files: ["x.js", "y.js"], leaseExpiresAt: "2026-10-20T05:00:00Z" },
  { id: "b", state: "in_progress", owner: "codex", files: ["x.js"], leaseExpiresAt: "2026-10-19T05:00:00Z" },
  { id: "c", state: "done", owner: "fo", files: ["z.js"] },
  { id: "d", state: "unclaimed", files: ["q.js"], dependsOn: ["c"] },
  { id: "e", state: "unclaimed", dependsOn: ["a"] },
];

test("claim map keys live leases by path and drops lapsed and terminal claims", () => {
  const map = buildClaimMap(items, now);
  assert.deepEqual(Object.keys(map.paths).sort(), ["x.js", "y.js"]);
  assert.equal(map.paths["x.js"].length, 1);
  assert.equal(map.paths["x.js"][0].owner, "grok");
  assert.deepEqual(map.claims.map(c => c.claimId), ["a"]);
});

test("work-ready lists unclaimed items whose dependencies are terminal", () => {
  assert.deepEqual(buildWorkReady(items).ready.map(r => r.claimId), ["d"]);
});

test("routes are read-only room GETs", () => {
  for (const route of CLAIM_MAP_ROUTES) {
    assert.equal(route.method, "GET");
    assert.equal(route.auth, "room");
    assert.deepEqual(route.events, []);
  }
});

import { authenticateRoomRead } from "../server/routes/room-read-guard.mjs";

const guardCtx = ({ scopes = ["rooms:read"], member = { active: true } } = {}) => ({
  params: { roomId: "r1" }, req: {}, url: new URL("https://room.example/x"),
  roomCredentials: () => ({ bearer: true, mode: "room", token: "t" }),
  expectedBinding: () => null, accountBinding: () => null,
  roomAuth: () => ({ kind: "api-key", credentialScope: "room", credentialHash: "h", apiKeyScopes: scopes, member: { id: "m1" } }),
  rate: () => {},
  reject: (status, code) => { throw Object.assign(new Error(code), { status }); },
  store: { roomAuthority: () => ({ members: member ? { m1: member } : {} }) },
});

test("room read guard requires rooms:read and active membership", () => {
  assert.equal(authenticateRoomRead(guardCtx()).roomId, "r1");
  assert.throws(() => authenticateRoomRead(guardCtx({ scopes: ["rooms:write"] })), /insufficient_scope/);
  assert.throws(() => authenticateRoomRead(guardCtx({ member: null })), /not_member/);
  assert.throws(() => authenticateRoomRead(guardCtx({ member: { active: false } })), /not_member/);
});
