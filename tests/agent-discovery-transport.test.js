import test from "node:test";
import assert from "node:assert/strict";
import { createAgentIdentity, createAgentRoom, previewAgentInvite, redeemAgentInvite, requestAccess, listAgentRooms } from "../client/room-agent.mjs";

const secret = `pri_${"x".repeat(43)}`;
const cases = [
  ["identity", (origin, options) => createAgentIdentity(origin, "Agent", options), { identityId: "ai_test", secret }],
  ["create", (origin, options) => createAgentRoom(origin, secret, { roomId: "test" }, options), { roomId: "test", ownerMemberId: "ai_test" }],
  ["preview", (origin, options) => previewAgentInvite(origin, "RM-code", options), { roomId: "test", permissions: [], profile: "chat" }],
  ["redeem", (origin, options) => redeemAgentInvite(origin, "RM-code", "Agent", options), { identityId: "ai_test", secret, memberId: "ai_test" }],
  ["access", (origin, options) => requestAccess(origin, { roomId: "test" }, options), { requestId: "ar_test", status: "pending" }],
  ["rooms", (origin, options) => listAgentRooms(origin, secret, options), { identityId: "ai_test", rooms: [], nextCursor: null }],
];
for (const [name, invoke, value] of cases) {
  test(`${name}: shared discovery transport retains boundaries and failure contracts`, async () => {
    const controller = new AbortController();
    let captured;
    const fetchImpl = async (url, init) => { captured = { url, ...init }; return Response.json(value); };
    assert.deepEqual(await invoke("https://www.getdasha.com", { fetchImpl, signal: controller.signal }), value);
    assert.ok(captured.url.startsWith("https://www.getdasha.com/room/api/"));
    assert.equal(captured.redirect, "error");
    assert.equal(captured.credentials, "omit");
    assert.equal(captured.signal.aborted, false);
    controller.abort();
    assert.equal(captured.signal.aborted, true);
    assert.equal(captured.headers?.Authorization, ["create", "rooms"].includes(name) ? `Bearer ${secret}` : undefined);
    assert.ok(!captured.url.includes(secret) && !captured.body?.includes(secret));
    await assert.rejects(invoke("http://example.com", { fetchImpl: () => assert.fail("invalid origin must not fetch") }), { code: "invalid_config" });
    await assert.rejects(invoke("https://example.com", { fetchImpl: async () => { throw new Error("private network detail"); } }),
      { code: "service_unavailable", message: "Could not complete the request. Check the service address and retry." });
    await assert.rejects(invoke("https://example.com", { fetchImpl: async () => Response.json({ error: { code: "denied", message: "Denied" } }, { status: 403 }) }),
      { status: 403, code: "denied", message: "Denied" });
    await assert.rejects(invoke("https://example.com", { fetchImpl: async () => new Response("not json") }), { code: "invalid_response" });
  });
}
