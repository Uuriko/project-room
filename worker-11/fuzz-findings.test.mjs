// WAVE-2000 guild-02 worker-11: fail-first tests for wrong-status findings.
// Finding: several 405 "method_not_allowed" responses omit the Allow header
// that RFC 7231 §6.5.5 REQUIRES on a 405. These currently FAIL (red).
// Routes in worker-11's shard: R160 mention-ack, R210 bounties, R60 auth-methods.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "commons";
async function boot(t, seed = false) {
  const fixture = createAcceptanceFixture();
  if (seed) {
    const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
    fixture.store.transaction(() => {
      escrow._ensure();
      const at = new Date().toISOString();
      for (const memberId of ["owner", "guest"]) {
        escrow._append({ roomId: ROOM, accountId: memberId, at, kind: "genesis",
          amount: 100 * 1000, lotState: "payable", memo: "seed", actor: { kind: "rule", id: "test" } });
      }
    });
  }
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); fixture.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = (method, path, key, body) => fetch(`${origin}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { req, keys: fixture.keys, fixture };
}

test("R160: GET /api/rooms/{id}/mentions/{eid}/ack -> 405 MUST carry Allow: POST", async t => {
  const { req, keys, fixture } = await boot(t);
  fixture.store.command(keys.owner, ROOM, { id: randomUUID(), type: "message.posted",
    data: { messageId: "m1", body: "hey @guest", toMemberId: "guest" } });
  const { mentions } = fixture.store.listMentions(keys.guest, ROOM, {});
  const r = await req("GET", `/api/rooms/${ROOM}/mentions/${mentions[0].messageEventId}/ack`, keys.guest);
  assert.equal(r.status, 405);
  assert.ok(r.headers.get("allow"), "405 must include an Allow header (RFC 7231 6.5.5)");
});

test("R210: PUT /api/rooms/{id}/bounties -> 405 MUST carry Allow", async t => {
  const { req, keys } = await boot(t, true);
  const r = await req("PUT", `/api/rooms/${ROOM}/bounties`, keys.owner,
    { title: "t", criteria: "c", amount: 1, deadline: new Date(Date.now() + 864e5).toISOString() });
  assert.equal(r.status, 405);
  assert.ok(r.headers.get("allow"), "405 must include an Allow header (RFC 7231 6.5.5)");
});

test("R60: GET /api/auth/methods/remove -> 405 MUST carry Allow: POST", async t => {
  const { req } = await boot(t);
  // method gate runs before auth, so no credential is needed
  const res = await req("GET", "/api/auth/methods/remove", "nope", undefined);
  assert.equal(res.status, 405);
  assert.ok(res.headers.get("allow"), "405 must include an Allow header (RFC 7231 6.5.5)");
});
