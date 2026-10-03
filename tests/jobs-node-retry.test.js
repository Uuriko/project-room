// A self-hosted Room retries a failing webhook receiver on the same
// scheduler production uses, then dead-letters it. The clock is the store
// clock so the backoff is the real delay without waiting on the wall clock.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { wireNodeJobs } from "../server/jobs.mjs";
import { backoffDelayMs, MAX_DELIVERY_ATTEMPTS } from "../server/webhook-dispatch.mjs";

const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };

test("node scheduler retries a failing webhook receiver then dead-letters it", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-jobs-retry-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Hook Agent");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId: "hookagent", displayName: "Hook Agent", permissions: []
  });
  const posts = [];
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const scheduler = wireNodeJobs(store, {
    env: { GROWTH_WATCH_INTERVAL_MS: "0" },
    now: () => clock,
    tickMs: 0,
    fetchImpl: async () => {
      posts.push(clock);
      return { status: 500, headers: { get: () => null }, text: async () => "unavailable" };
    },
    dnsResolvers: publicDns
  });
  t.after(async () => {
    scheduler.stop();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await scheduler.runOnce();

  const subscribed = await fetch(`${origin}/api/agent-webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${identity.secret}` },
    body: JSON.stringify({ url: "https://hooks.example.test/hook", events: ["message.posted"] })
  });
  assert.equal(subscribed.status, 201, await subscribed.clone().text());
  const posted = await fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "hello from the room" } })
  });
  assert.equal(posted.status, 201, await posted.clone().text());
  for (let i = 0; i < 50 && posts.length < 1; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(posts.length, 1, "the post-commit kick attempts the delivery once");

  const delivery = () => store.db.prepare(
    "SELECT state, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError FROM agent_webhook_deliveries"
  ).get();
  let row = delivery();
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 1);
  assert.equal(row.nextAttemptAt, posts[0] + backoffDelayMs(1));

  clock = row.nextAttemptAt - 1;
  await scheduler.runOnce();
  assert.equal(posts.length, 1, "a retry waits until next_attempt_at");

  while (posts.length < MAX_DELIVERY_ATTEMPTS) {
    row = delivery();
    assert.equal(row.state, "failed");
    const attempts = row.attempts;
    clock = row.nextAttemptAt;
    await scheduler.runOnce();
    assert.equal(posts.length, attempts + 1);
    row = delivery();
    if (row.state === "failed") assert.equal(row.nextAttemptAt, clock + backoffDelayMs(row.attempts));
  }
  row = delivery();
  assert.equal(posts.length, MAX_DELIVERY_ATTEMPTS);
  assert.equal(row.state, "dead_letter");
  assert.equal(row.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.match(row.lastError, /gave up after 5 attempts/);
  clock = row.nextAttemptAt ?? clock + 1;
  await scheduler.runOnce();
  assert.equal(posts.length, MAX_DELIVERY_ATTEMPTS, "a dead letter is not sent again");
});
