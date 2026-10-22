import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { openRequestJournal, runRequestQueue, isRequestEligible } from "../client/request-runner.mjs";

// Count actual authorized HTTP responses, not mocked client call shapes.
for (const blocked of [false, true]) test(`idle queue excludes cancelled history and avoids blocked preparation: ${blocked}`, { timeout: 15000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  const controller = new AbortController(), reads = [], notices = [];
  const db = openRequestJournal(join(f.directory, "queue.sqlite"));
  let executed = 0, listings = 0;
  const listen = s => new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const gateway = createServer(async (req, res) => {
    if (req.url.endsWith("/agent-work") && ++listings === 2) {
      controller.abort(); res.writeHead(204); res.end(); return;
    }
    try {
      const upstream = await fetch(origin + req.url, { headers: req.headers });
      const body = await upstream.text();
      reads.push({ path: req.url, bytes: Buffer.byteLength(body), body: JSON.parse(body) });
      res.writeHead(upstream.status, { "Content-Type": "application/json" }); res.end(body);
    } catch { res.writeHead(502); res.end(); }
  });
  t.after(async () => {
    controller.abort(); gateway.closeAllConnections(); server.closeStreams(); server.closeAllConnections();
    await Promise.all([gateway, server].map(s => s.listening ? new Promise(resolve => s.close(resolve)) : null));
    db.close(); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  f.store.dmConsents.request("commons", "owner", "producer", "queue fixture");
  f.store.dmConsents.decide("commons", "producer", "owner", "approve");
  for (let i = 0; i < 20; i++) {
    const id = `closed-${i}`;
    f.store.command(f.keys.owner, "commons", { id, type: "message.posted", data: {
      messageId: id, requestKind: "reply", toMemberId: "producer", body: "Old request" } });
    f.store.command(f.keys.owner, "commons", { id: `cancel-${i}`, type: "reply_request.cancelled", data: {
      requestMessageId: id, expectedRequestRevision: 0, reason: "No longer needed" } });
  }
  if (blocked) {
    f.store.command(f.keys.owner, "commons", { id: "blocked-open", type: "message.posted", data: {
      messageId: "blocked-open", requestKind: "reply", toMemberId: "producer", body: "Current request" } });
    f.store.dmConsents.block("commons", "owner", "producer");
  }
  const before = f.store.room("commons").sequence;
  await listen(gateway);
  await runRequestQueue({ connection: { version: 1, origin: `http://127.0.0.1:${gateway.address().port}`,
    roomId: "commons", memberId: "producer", token: f.keys.producer }, db,
    execute: async () => { executed++; throw new Error("Cancelled requests must not execute"); },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), stream: false,
    intervalMs: 1000, emit: value => notices.push(value) });
  assert.equal(listings, 2, "one complete idle scan followed by the next scan");
  assert.equal(executed, 0);
  assert.deepEqual(notices, []);
  assert.equal(f.store.room("commons").sequence, before);
  const listing = reads.find(read => read.path.endsWith("/agent-work"));
  assert.equal(reads.length, 1, "one combined read replaces preflight and separate lists");
  assert.deepEqual(listing.body.requests.map(r => r.id), blocked ? ["blocked-open"] : [], "closed history must not cross the queue's HTTP boundary");
  if (blocked) assert.deepEqual(listing.body.blockedBy, { "blocked-open": ["dm_blocked"] });
  assert.equal(reads.filter(read => read.path.endsWith("/request-runs")).length, 0);
  t.diagnostic(`idle request listing: ${listing.bytes} bytes; ${reads.length} completed HTTP reads before next scan`);
});

// A standing observation suppresses new execution, never discards a saved answer.
test("blocked pickup preserves local recovery and ownership fences", () => {
  const request = { id: "q", status: "open" };
  assert.equal(isRequestEligible(request, { owned: false, blocked: true }), false);
  assert.equal(isRequestEligible(request, { owned: false, blocked: false }), true);
  assert.equal(isRequestEligible(request, { owned: true, blocked: true, runState: "result_ready", hasPendingDelivery: true }), true);
  assert.equal(isRequestEligible(request, { owned: true, blocked: true, runState: "result_ready", hasPendingDelivery: false }), false);
  assert.equal(isRequestEligible(request, { owned: true, blocked: true, runState: "needs_attention", hasPendingDelivery: true }), false);
  assert.equal(isRequestEligible({ ...request, status: "closed" }, { owned: true, blocked: true, runState: "result_ready", hasPendingDelivery: true }), false);
});
