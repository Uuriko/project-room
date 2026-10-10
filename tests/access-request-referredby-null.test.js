// The web "Request access" form sends referredBy: null when "Who referred
// you?" is blank. The HTTP gate must accept null, as the service already
// does (server/access-requests.mjs), so a blank referrer files the request.
// Old cached clients still send null, so the server must accept it.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});

test("POST /api/access-requests accepts referredBy null, omitted or text, and still refuses a wrong type", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const owner = fixture.store.identities.create("refnull owner");
  const roomId = "refnull-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Referrer null", purpose: "probe", kind: "personal", displayName: "Referrer null",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const cases = [
    ["null", { referredBy: null }, 201],
    ["omitted", {}, 201],
    ["text", { referredBy: "Owner" }, 201],
    ["number", { referredBy: 7 }, 422],
  ];
  for (const [label, extra, status] of cases) {
    const friend = fixture.store.identities.create(`refnull ${label} friend`);
    const res = await post(origin, "/api/access-requests", {
      roomId, identityId: friend.identityId, displayName: `Ref ${label}`,
      requestedPermissions: ["accept_work"], note: null, ...extra,
    });
    assert.equal(res.status, status, `referredBy ${label} -> ${status}`);
    if (status === 201) assert.equal((await res.json()).status, "pending");
  }
});
