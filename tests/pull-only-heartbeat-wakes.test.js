// Online pull-only hosts receive mention wakes on the next heartbeat.
//
// Authoring gate:
// 1. Contract: a heartbeating pull-only host's next POST /api/agent-heartbeats
//    returns exactly that mention; ack clears it; 120 mentions return the
//    50 oldest signals and more:true.
// 2. Regression: skipping a fresh pull-only host, or dropping the truncation
//    flag from the heartbeat page.
// 3. Existing tests covered stale pull-only delivery and the wakeable poll.
//    They did not observe an online pull-only heartbeat, and nothing asserted
//    the 50-signal page.
// 4. No new production seam. Heartbeat and ack are the HTTP routes. The
//    120-mention burst uses store.command, the same call the command route
//    makes, because that route allows 60 writes a minute.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify(body),
});
const get = (origin, path, secret) => fetch(`${origin}${path}`, {
  headers: { authorization: `Bearer ${secret}` },
});

function seat(t) {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const identity = f.store.identities.create("Pull Host");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "pullhost",
    displayName: "Pull Host", permissions: [],
  });
  return { f, identity, clock: { advance: ms => { at += ms; } } };
}

async function beat(origin, secret) {
  const response = await post(origin, "/api/agent-heartbeats", { hostId: "pull-host", mode: "pull-only" }, secret);
  assert.equal(response.status, 200);
  return response.json();
}

test("an online pull-only host receives a mention on its next heartbeat and ack clears it", async t => {
  const { f, identity } = seat(t);
  const origin = await startServer(t, f);
  const first = await beat(origin, identity.secret);
  assert.equal(first.host.mode, "pull-only");
  assert.deepEqual(first.pendingWakes, []);
  assert.equal(first.more, false);
  const presence = await (await get(origin, "/api/agent-heartbeats", identity.secret)).json();
  assert.equal(presence.status, "online");

  const mentioned = await post(origin, "/api/rooms/commons/commands", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "mention-online", body: "@pullhost please look" },
  }, f.keys.owner);
  assert.equal(mentioned.status, 201);

  const queued = await beat(origin, identity.secret);
  assert.equal(queued.pendingWakes.length, 1);
  assert.equal(queued.pendingWakes[0].kind, "mention");
  assert.equal(queued.pendingWakes[0].roomId, "commons");
  assert.equal(queued.pendingWakes[0].messageId, "mention-online");
  assert.equal(queued.more, false);

  const ack = await post(origin, "/api/agent-heartbeats/ack", {
    signalIds: [queued.pendingWakes[0].signalId],
  }, identity.secret);
  assert.equal(ack.status, 200);
  assert.deepEqual((await ack.json()).acknowledged, [queued.pendingWakes[0].signalId]);
  const cleared = await beat(origin, identity.secret);
  assert.deepEqual(cleared.pendingWakes, []);
  assert.equal(cleared.more, false);
});

test("120 mentions return the 50 oldest heartbeat signals and more:true", async t => {
  const { f, identity, clock } = seat(t);
  const origin = await startServer(t, f);
  await beat(origin, identity.secret);
  const ids = [];
  for (let i = 0; i < 120; i += 1) {
    if (i > 0 && i % 25 === 0) {
      clock.advance(60_000);
      await beat(origin, identity.secret);
    }
    clock.advance(1);
    const messageId = `m${String(i).padStart(3, "0")}`;
    ids.push(messageId);
    f.store.command(f.keys.owner, "commons", {
      id: randomUUID(), type: "message.posted",
      data: { messageId, body: `@pullhost please look at ${messageId}` },
    });
  }
  assert.equal(ids.length, 120);
  const presence = await (await get(origin, "/api/agent-heartbeats", identity.secret)).json();
  assert.equal(presence.status, "online");
  const page = await beat(origin, identity.secret);
  assert.equal(page.pendingWakes.length, 50);
  assert.deepEqual(page.pendingWakes.map(signal => signal.messageId), ids.slice(0, 50));
  assert.equal(page.more, true);
});
