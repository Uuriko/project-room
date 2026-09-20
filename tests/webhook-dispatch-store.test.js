// Store + HTTP tests for signed webhook dispatch (RC-2026-09-19-064):
// durable per-delivery journal, idempotent fan-out, retry/backoff,
// dead-letter + redrive, metrics, restart persistence, and the HTTP
// surface. The fetch layer is always faked — no network in tests.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { verifyDeliverySignature } from "../server/webhook-dispatch.mjs";

const SECRET = "signing-secret-0123456789abcdef";
const okFetch = (status = 200) => async () => ({ status, text: async () => "ok" });
const errorFetch = message => async () => { throw new Error(message); };
// QA-Sec 2026-09-19: dispatch re-validates the target (incl. DNS) before
// every POST, so drains inject a resolver that answers "public" for the
// test hostname. No network in tests.
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const drain = (store, extra = {}) =>
  store.agentPlugin.drainWebhookDeliveries({ dnsResolvers: publicDns, ...extra });

function freshFixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { try { f.store.close(); } catch {} });
  return f;
}

function subscribe(t, store, name = "hook-agent", events = ["message.posted"]) {
  const identity = store.identities.create(name);
  const { subscription } = store.agentPlugin.subscribeWebhook({
    identityId: identity.identityId, url: "https://hooks.example.test/agent",
    events, secret: SECRET,
  });
  return { identity, subscription };
}

function postMessage(store, keys, body = "hello world") {
  return store.command(keys.owner, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body },
  });
}

test("fan-out journals one pending delivery per matching event, idempotently", t => {
  const f = freshFixture(t);
  const { identity, subscription } = subscribe(t, f.store);
  const { event } = postMessage(f.store, f.keys);
  const journal = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(journal.length, 1);
  const entry = journal[0];
  assert.equal(entry.eventType, "message.posted");
  assert.equal(entry.state, "pending");
  assert.equal(entry.attempts, 0);
  assert.equal(entry.error, null);
  assert.ok(Number.isInteger(entry.createdAt));
  assert.ok(Number.isInteger(entry.updatedAt));
  assert.ok(Number.isInteger(entry.nextAttemptAt));
  // The journal view is secret-safe.
  for (const forbidden of ["secret", "signature", "url", "data"]) {
    assert.ok(!(forbidden in entry), `journal must not expose ${forbidden}`);
  }
  // Replaying the same event is a no-op for deliveries (idempotency).
  const fanout = f.store.agentPlugin.fanoutRoomEvent({ roomId: "commons", event });
  assert.equal(fanout.deliveries, 0);
  assert.equal(f.store.agentPlugin.webhookJournal(subscription.subscriptionId).length, 1);
  // Non-matching events and disabled subscriptions produce nothing.
  const other = subscribe(t, f.store, "other-agent", ["thread.created"]);
  assert.equal(f.store.agentPlugin.webhookJournal(other.subscription.subscriptionId).length, 0);
  assert.equal(identity.identityId.length > 0, true);
});

test("drain signs each delivery per the wire contract", async t => {
  const f = freshFixture(t);
  const { subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  const captured = [];
  await drain(f.store, {
    fetchImpl: async (url, opts) => {
      captured.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      return { status: 200, text: async () => "ok" };
    },
  });
  assert.equal(captured.length, 1);
  const { url, headers, body } = captured[0];
  assert.equal(url, "https://hooks.example.test/agent");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-webhook-event"], "message.posted");
  assert.equal(headers["x-webhook-subscription"], subscription.subscriptionId);
  assert.equal(headers["x-webhook-delivery"], body.deliveryId);
  assert.equal(body.subscriptionId, subscription.subscriptionId);
  assert.equal(body.eventType, "message.posted");
  assert.equal(body.roomId, "commons");
  assert.ok(body.data);
  // The signature verifies over deliveryId + eventType + timestamp + data.
  const issuedAt = Date.parse(body.issuedAt);
  assert.ok(Number.isInteger(issuedAt));
  assert.equal(verifyDeliverySignature(SECRET, headers["x-webhook-signature"], {
    deliveryId: body.deliveryId, eventType: body.eventType, issuedAt, data: body.data,
  }), true);
  // The timestamp is fresh (signed at dispatch, not at fan-out).
  assert.ok(Math.abs(Date.now() - issuedAt) < 60_000);
  assert.ok(Math.abs(Date.now() - Date.parse(headers["x-webhook-timestamp"])) < 60_000);
  // Tampering breaks verification.
  assert.equal(verifyDeliverySignature(SECRET, headers["x-webhook-signature"], {
    deliveryId: body.deliveryId, eventType: body.eventType, issuedAt,
    data: { ...body.data, forged: true },
  }), false);
});

test("drain delivers with a fake fetch and records delivered", async t => {
  const f = freshFixture(t);
  const { subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  const summary = await drain(f.store, { fetchImpl: okFetch(200) });
  assert.deepEqual(summary, { processed: 1, delivered: 1, retried: 0, deadLettered: 0, skipped: 0 });
  const [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "delivered");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.error, null);
});

test("retryable failures back off and then deliver within 3 attempts", async t => {
  const f = freshFixture(t);
  const { subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  let calls = 0;
  const flaky = async () => (++calls <= 2
    ? { status: 503, text: async () => "busy" }
    : { status: 200, text: async () => "ok" });
  const now = Date.now();
  const first = await drain(f.store, { fetchImpl: flaky, now });
  assert.equal(first.retried, 1);
  let [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "failed");
  assert.equal(entry.attempts, 1);
  assert.match(entry.error, /HTTP 503/);
  assert.ok(entry.nextAttemptAt > now, "next attempt is scheduled in the future");
  // A sweep before the backoff elapses does nothing.
  const early = await drain(f.store, { fetchImpl: flaky, now: now + 1000 });
  assert.equal(early.processed, 0);
  // After the backoff, the second attempt also fails; the third succeeds.
  const second = await drain(f.store, { fetchImpl: flaky, now: entry.nextAttemptAt + 1 });
  assert.equal(second.retried, 1);
  [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "failed");
  assert.equal(entry.attempts, 2);
  const third = await drain(f.store, { fetchImpl: flaky, now: entry.nextAttemptAt + 1 });
  assert.equal(third.delivered, 1);
  [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "delivered");
  assert.equal(entry.attempts, 3);
  assert.equal(entry.error, null);
});

test("permanent rejections dead-letter immediately without retry", async t => {
  const f = freshFixture(t);
  const { subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  const summary = await drain(f.store, { fetchImpl: okFetch(400) });
  assert.deepEqual(summary, { processed: 1, delivered: 0, retried: 0, deadLettered: 1, skipped: 0 });
  const [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "dead_letter");
  assert.equal(entry.attempts, 1);
  assert.match(entry.error, /not retried/);
});

test("drain dead-letters a delivery whose hostname resolves private at dispatch (DNS rebinding)", async t => {
  const f = freshFixture(t);
  const { identity, subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  // The name passed the subscribe-time checks; at dispatch it resolves to
  // the cloud metadata address. The fetch must never fire.
  let fetched = 0;
  const summary = await drain(f.store, {
    fetchImpl: async () => { fetched++; return { status: 200, text: async () => "ok" }; },
    dnsResolvers: { resolve4: async () => ["169.254.169.254"], resolve6: async () => [] },
  });
  assert.deepEqual(summary, { processed: 1, delivered: 0, retried: 0, deadLettered: 1, skipped: 0 });
  assert.equal(fetched, 0);
  const [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "dead_letter");
  assert.match(entry.error, /private or reserved/);
  void identity;
});

test("drain never follows a redirect downgrade to an internal http target", async t => {
  const f = freshFixture(t);
  const { subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  const seen = [];
  const summary = await drain(f.store, {
    fetchImpl: async url => {
      seen.push(url);
      if (url === "https://hooks.example.test/agent") {
        return { status: 307,
          headers: { get: name => (name === "location" ? "http://127.0.0.1:8444/internal-callback" : null) },
          text: async () => "" };
      }
      throw new Error("redirect target must never be fetched: " + url);
    },
  });
  assert.deepEqual(summary, { processed: 1, delivered: 0, retried: 0, deadLettered: 1, skipped: 0 });
  assert.deepEqual(seen, ["https://hooks.example.test/agent"]);
  const [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "dead_letter");
  assert.match(entry.error, /downgrade/);
});

test("exhausted retries dead-letter after 5 attempts", async t => {
  const f = freshFixture(t);
  const { subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  let now = Date.now();
  let summary;
  for (let i = 0; i < 5; i++) {
    summary = await drain(f.store, { fetchImpl: okFetch(500), now });
    const [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
    now = entry.nextAttemptAt + 1;
  }
  assert.equal(summary.deadLettered, 1);
  const [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(entry.state, "dead_letter");
  assert.equal(entry.attempts, 5);
  assert.match(entry.error, /gave up after 5 attempts/);
  // Dead letters are not swept again.
  const again = await drain(f.store, { fetchImpl: okFetch(200), now: now + 1_000_000 });
  assert.equal(again.processed, 0);
});

test("network failures are retryable and counted as attempts", async t => {
  const f = freshFixture(t);
  subscribe(t, f.store);
  postMessage(f.store, f.keys);
  const summary = await drain(f.store, { fetchImpl: errorFetch("connect ECONNREFUSED") });
  assert.equal(summary.retried, 1);
});

test("redrive returns a dead letter to pending with a clean counter", async t => {
  const f = freshFixture(t);
  const { identity, subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  await drain(f.store, { fetchImpl: okFetch(400) });
  const [dead] = f.store.agentPlugin.deadLettersFor({ identityId: identity.identityId });
  assert.equal(dead.state, "dead_letter");
  const redriven = f.store.agentPlugin.redriveDeadLetter({ identityId: identity.identityId, deliveryId: dead.deliveryId });
  assert.equal(redriven.state, "pending");
  assert.equal(redriven.attempts, 0);
  assert.equal(redriven.error, null);
  // It delivers on the next sweep.
  const summary = await drain(f.store, { fetchImpl: okFetch(200) });
  assert.equal(summary.delivered, 1);
  // Redriving a live delivery is rejected; cross-identity reads 404.
  const { identity: stranger } = subscribe(t, f.store, "stranger-agent");
  const [entry] = f.store.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.throws(() => f.store.agentPlugin.redriveDeadLetter({ identityId: identity.identityId, deliveryId: entry.deliveryId }),
    error => error.status === 422 && error.code === "not_dead_letter");
  assert.throws(() => f.store.agentPlugin.redriveDeadLetter({ identityId: stranger.identityId, deliveryId: entry.deliveryId }),
    error => error.status === 404 && error.code === "unknown_delivery");
  assert.throws(() => f.store.agentPlugin.redriveDeadLetter({ identityId: identity.identityId, deliveryId: "del_missing" }),
    error => error.status === 404 && error.code === "unknown_delivery");
});

test("metrics measure the falsifiable claim; zero-sample is honestly null", async t => {
  const f = freshFixture(t);
  const { identity } = subscribe(t, f.store);
  const empty = f.store.agentPlugin.deliveryMetricsFor({ identityId: identity.identityId });
  assert.equal(empty.totalTerminal, 0);
  assert.equal(empty.deliveryRateWithin3Attempts, null);
  assert.match(empty.claim, /99%/);
  postMessage(f.store, f.keys, "first");
  postMessage(f.store, f.keys, "second");
  await drain(f.store, { fetchImpl: okFetch(200) });
  const metrics = f.store.agentPlugin.deliveryMetricsFor({ identityId: identity.identityId });
  assert.equal(metrics.totalTerminal, 2);
  assert.equal(metrics.delivered, 2);
  assert.equal(metrics.deliveredWithin3Attempts, 2);
  assert.equal(metrics.deliveryRateWithin3Attempts, 1);
  assert.equal(metrics.deadLettered, 0);
  assert.equal(metrics.maxAttempts, 5);
});

test("deliveries survive a store restart", async t => {
  const f = createAcceptanceFixture();
  const { identity, subscription } = subscribe(t, f.store);
  postMessage(f.store, f.keys);
  await drain(f.store, { fetchImpl: okFetch(500) });
  f.store.close();
  const reopened = new RoomStore(join(f.directory, "room.sqlite"), { now: () => Date.now() });
  t.after(() => { try { reopened.close(); } catch {} });
  const journal = reopened.agentPlugin.webhookJournal(subscription.subscriptionId);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].state, "failed");
  assert.equal(journal[0].attempts, 1);
  // The reopened store can keep dispatching: the failed delivery is due.
  const summary = await reopened.agentPlugin.drainWebhookDeliveries({
    fetchImpl: okFetch(200), now: journal[0].nextAttemptAt + 1, dnsResolvers: publicDns });
  assert.equal(summary.delivered, 1);
  const metrics = reopened.agentPlugin.deliveryMetricsFor({ identityId: identity.identityId });
  assert.equal(metrics.deliveryRateWithin3Attempts, 1);
});

test("delivery log scopes to the calling identity", async t => {
  const f = freshFixture(t);
  const a = subscribe(t, f.store, "agent-a");
  const b = subscribe(t, f.store, "agent-b");
  postMessage(f.store, f.keys);
  assert.equal(f.store.agentPlugin.deliveryLogFor({ identityId: a.identity.identityId }).length, 1);
  assert.equal(f.store.agentPlugin.deliveryLogFor({ identityId: b.identity.identityId }).length, 1);
  assert.equal(f.store.agentPlugin.deliveryLogFor({ identityId: "ai_nobody" }).length, 0);
  assert.throws(() => f.store.agentPlugin.deliveryLogFor({ identityId: a.identity.identityId, state: "bogus" }),
    error => error.status === 422 && error.code === "invalid_state");
});

// ---- HTTP surface ----

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
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const post = (origin, path, secret = null, body = {}) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});

test("HTTP: deliveries, dead-letter, redrive, metrics, process routes", async t => {
  // Note: startServer's after-hook owns f.store.close(); no freshFixture
  // auto-close here or the store is closed twice.
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("http-hook-agent");
  const stranger = f.store.identities.create("http-stranger");
  const secret = identity.secret;

  // Unauthenticated reads are rejected.
  assert.equal((await get(origin, "/api/agent-webhooks/deliveries")).status, 401);
  assert.equal((await get(origin, "/api/agent-webhooks/metrics")).status, 401);
  assert.equal((await post(origin, "/api/agent-webhooks/process")).status, 401);

  // Subscribe, trigger a delivery via a real room message, then inspect.
  // The receiver URL is unroutable in tests on purpose: dispatch itself is
  // exercised at the store level with a fake fetch, so no test here ever
  // touches the network.
  const subRes = await post(origin, "/api/agent-webhooks", secret,
    { url: "https://hooks.example.test/agent", events: ["message.posted"], secret: SECRET });
  assert.equal(subRes.status, 201);
  const { subscriptionId } = await subRes.json();
  postMessage(f.store, f.keys);

  const log = await (await get(origin, "/api/agent-webhooks/deliveries", secret)).json();
  assert.equal(log.deliveries.length, 1);
  assert.equal(log.deliveries[0].state, "pending");
  assert.ok(Array.isArray(log.next) && log.next.some(n => n.path === "/api/agent-webhooks/metrics"));

  const byState = await (await get(origin, "/api/agent-webhooks/deliveries?state=pending", secret)).json();
  assert.equal(byState.deliveries.length, 1);
  const none = await (await get(origin, "/api/agent-webhooks/deliveries?state=delivered", secret)).json();
  assert.equal(none.deliveries.length, 0);
  assert.equal((await get(origin, "/api/agent-webhooks/deliveries?state=bogus", secret)).status, 422);

  const metrics = await (await get(origin, "/api/agent-webhooks/metrics", secret)).json();
  assert.equal(metrics.totalTerminal, 0);
  assert.equal(metrics.deliveryRateWithin3Attempts, null);

  // The process endpoint sweeps the caller's own deliveries. With nothing
  // due it reports an honest zero sweep without touching the network.
  await drain(f.store, { fetchImpl: okFetch(200) });
  const processed = await (await post(origin, "/api/agent-webhooks/process", secret)).json();
  assert.deepEqual(processed.summary, { processed: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 0 });
  const deliveredLog = await (await get(origin, "/api/agent-webhooks/deliveries?state=delivered", secret)).json();
  assert.equal(deliveredLog.deliveries.length, 1);
  const metricsAfter = await (await get(origin, "/api/agent-webhooks/metrics", secret)).json();
  assert.equal(metricsAfter.deliveryRateWithin3Attempts, 1);

  // Cross-identity reads see nothing.
  const strangerLog = await (await get(origin, "/api/agent-webhooks/deliveries", stranger.secret)).json();
  assert.equal(strangerLog.deliveries.length, 0);
  assert.equal((await get(origin, `/api/agent-webhooks/${subscriptionId}/deliveries`, stranger.secret)).status, 404);

  // Dead-letter queue and redrive: a second message, then a deterministic
  // receiver rejection (400) at the store level.
  postMessage(f.store, f.keys, "second message");
  await drain(f.store, { fetchImpl: okFetch(400) });
  const dlq = await (await get(origin, "/api/agent-webhooks/dead-letter", secret)).json();
  assert.equal(dlq.deliveries.length, 1);
  assert.equal(dlq.deliveries[0].state, "dead_letter");
  assert.ok(dlq.next.some(n => n.action === "redrive"));
  const deliveryId = dlq.deliveries[0].deliveryId;
  const redrive = await post(origin, `/api/agent-webhooks/deliveries/${deliveryId}/redrive`, secret);
  assert.equal(redrive.status, 200);
  assert.equal((await redrive.json()).delivery.state, "pending");
  // Strangers cannot redrive what they cannot see.
  assert.equal((await post(origin, `/api/agent-webhooks/deliveries/${deliveryId}/redrive`, stranger.secret)).status, 404);
  // Redriving a non-dead delivery is a 422.
  assert.equal((await post(origin, `/api/agent-webhooks/deliveries/${deliveryId}/redrive`, secret)).status, 422);
  // And the redriven delivery completes on the next sweep.
  await drain(f.store, { fetchImpl: okFetch(200) });
  const redelivered = await (await get(origin, "/api/agent-webhooks/deliveries?state=delivered", secret)).json();
  assert.equal(redelivered.deliveries.length, 2);
});
