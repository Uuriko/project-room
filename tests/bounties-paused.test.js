// KI-070 / KI-012: new bounty work is paused in production (bounties cut
// from the MVP); reads keep working so held escrow can settle.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { bountyNewWorkEnabled } from "../server/bounty-flag.mjs";

const ROOM = "commons";

test("flag: paused in production by default, on elsewhere, explicit value wins", () => {
  assert.equal(bountyNewWorkEnabled({ ROOM_DEPLOYMENT: "production" }), false);
  assert.equal(bountyNewWorkEnabled({ ROOM_DEPLOYMENT: "production", ROOM_BOUNTY_WORK: "1" }), true);
  assert.equal(bountyNewWorkEnabled({}), true);
  assert.equal(bountyNewWorkEnabled({ ROOM_DEPLOYMENT: "staging" }), true);
  assert.equal(bountyNewWorkEnabled({ ROOM_BOUNTY_WORK: "0" }), false);
});

test("REST: paused bounties refuse post and claim with 403 bounties_paused; list still reads", async t => {
  const saved = process.env.ROOM_BOUNTY_WORK;
  process.env.ROOM_BOUNTY_WORK = "0";
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (saved === undefined) delete process.env.ROOM_BOUNTY_WORK; else process.env.ROOM_BOUNTY_WORK = saved;
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, secret, body) => {
    const res = await fetch(`${origin}${path}`, { method,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const created = await call("POST", `/api/rooms/${ROOM}/bounties`, fixture.keys.owner, {
    title: "Write the guide", criteria: "Cover it.", amount: 100,
    deadline: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(created.status, 403);
  assert.equal(created.json?.error?.code ?? created.json?.code, "bounties_paused");
  const claimed = await call("POST", `/api/rooms/${ROOM}/bounties/b-1/claim`, fixture.keys.producer, {});
  assert.equal(claimed.status, 403);
  assert.equal(claimed.json?.error?.code ?? claimed.json?.code, "bounties_paused");
  const listed = await call("GET", `/api/rooms/${ROOM}/bounties`, fixture.keys.owner);
  assert.equal(listed.status, 200);
});
