// WAKE0-3a: the operator wake-target allowlist (server/outbound-webhooks.mjs).
//
// Contract under test:
//  1. An operator-armed host (ROOM_WAKE_TARGET_ALLOWLIST, exact match)
//     validates wake-scoped: http allowed, any port, loopback/private OK.
//  2. An unarmed host gets the STRICT checks with identical codes/messages
//     — the loopback refusal is the synthesis ruling, not a bug.
//  3. The metadata plane can never be armed, even when the operator names it.
//  4. General (non-wake) webhooks are never relaxed, and a wake-only
//     subscription is the only subscription shape that relaxes.
//  5. Heartbeat push + wakeUrl and the journal drain consult the same gate.
//
// Synthetic fixtures only — fetch and DNS are injected mocks, one real
// loopback HTTP server for the end-to-end delivery leg. No external calls.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  operatorWakeTargetHosts, isOperatorWakeTarget, validateWebhookUrl,
  validateWakeTargetUrl, resolveWakeTarget, assertWakeTargetUrl, WebhookError,
  WAKE_TARGET_ALLOWLIST_ENV,
} from "../server/outbound-webhooks.mjs";
import { AgentHeartbeats, agentHeartbeatSchema, HeartbeatError } from "../server/agent-heartbeats.mjs";
import {
  createAgentWebhookSubscriptions, assertSubscriptionWebhookUrl, WebhookSubscriptionError,
} from "../server/agent-webhook-subscriptions.mjs";
import { createWebhooks } from "../server/outbound-webhooks.mjs";

const ENV = { [WAKE_TARGET_ALLOWLIST_ENV]: "127.0.0.1, bridge.lan, [::1]:8787, HTTP://Caps.Test:9999/wake" };

// ---- env parsing ---------------------------------------------------------

test("allowlist parses hosts case-insensitively, strips dots/brackets/ports/URLs", () => {
  const hosts = operatorWakeTargetHosts(ENV);
  assert.ok(hosts.has("127.0.0.1"));
  assert.ok(hosts.has("bridge.lan"));
  assert.ok(hosts.has("::1"), "bracketed IPv6 entry with a port arm the literal");
  assert.ok(hosts.has("caps.test"), "URL entries arm their hostname");
  assert.equal(hosts.size, 4);
  assert.equal(operatorWakeTargetHosts({}).size, 0);
  assert.equal(operatorWakeTargetHosts(undefined).size, 0, "missing env never throws");
});

test("arming is exact-host only: subdomains and lookalikes are not armed", () => {
  assert.equal(isOperatorWakeTarget("127.0.0.1", ENV), true);
  assert.equal(isOperatorWakeTarget("bridge.lan", ENV), true);
  assert.equal(isOperatorWakeTarget("sub.bridge.lan", ENV), false, "subdomains are not armed");
  assert.equal(isOperatorWakeTarget("bridge.lan.evil.test", ENV), false, "suffix lookalikes are not armed");
  assert.equal(isOperatorWakeTarget("127.0.0.1.", ENV), true, "trailing dot normalises");
  assert.equal(isOperatorWakeTarget("[::1]", ENV), true, "brackets normalise");
  assert.equal(isOperatorWakeTarget("10.0.0.1", ENV), false);
  assert.equal(isOperatorWakeTarget("127.0.0.1", {}), false, "no env, no arming");
});

test("the metadata plane can never be armed", () => {
  const hostile = { [WAKE_TARGET_ALLOWLIST_ENV]: "169.254.169.254, metadata.google.internal, fe80::1, ::ffff:169.254.169.254" };
  for (const host of ["169.254.169.254", "metadata.google.internal", "metadata", "fe80::1", "::ffff:169.254.169.254"]) {
    assert.equal(isOperatorWakeTarget(host, hostile), false, `${host} stays unarmed`);
    assert.throws(() => validateWakeTargetUrl(`http://${host}/wake`, { env: hostile }),
      err => err instanceof WebhookError, `${host} validates strict`);
  }
});

// ---- validation -----------------------------------------------------------

test("armed host: http + loopback + any port passes; unarmed: strict identical codes", () => {
  assert.equal(validateWakeTargetUrl("http://127.0.0.1:8787/wake", { env: ENV }), "http://127.0.0.1:8787/wake");
  assert.equal(validateWakeTargetUrl("http://bridge.lan/wake", { env: ENV }), "http://bridge.lan/wake");
  assert.equal(validateWakeTargetUrl("https://127.0.0.1:8787/wake", { env: ENV }), "https://127.0.0.1:8787/wake");
  // Unarmed hosts: the strict refusal, byte-identical to the public door.
  assert.throws(() => validateWakeTargetUrl("http://127.0.0.1:8787/wake", { env: {} }),
    err => err instanceof WebhookError && err.code === "invalid_webhook" && /must be a valid https URL/.test(err.message));
  assert.throws(() => validateWakeTargetUrl("https://10.0.0.5/wake", { env: ENV }),
    err => err instanceof WebhookError && err.code === "webhook_url_not_public" && /private or reserved IP/.test(err.message));
  // The strict validator itself never relaxes, even with the env set.
  assert.throws(() => validateWebhookUrl("http://127.0.0.1:8787/wake"), err => err instanceof WebhookError);
});

test("shape checks never relax for armed hosts: userinfo, control chars, length", () => {
  assert.throws(() => validateWakeTargetUrl("http://user:pass@127.0.0.1:8787/wake", { env: ENV }),
    err => err instanceof WebhookError && /without credentials/.test(err.message));
  assert.throws(() => validateWakeTargetUrl("http://127.0.0.1:8787/wa\u0001ke", { env: ENV }),
    err => err instanceof WebhookError && /control characters/.test(err.message));
  assert.throws(() => validateWakeTargetUrl("x".repeat(2001), { env: ENV }),
    err => err instanceof WebhookError && /1-2000/.test(err.message));
});

// ---- resolution ------------------------------------------------------------

test("resolveWakeTarget: armed literal pins itself; armed name accepts private answers; unarmed stays strict", async () => {
  const literal = await resolveWakeTarget("http://127.0.0.1:8787/wake", { env: ENV });
  assert.deepEqual(literal.addresses, ["127.0.0.1"]);
  const named = await resolveWakeTarget("http://bridge.lan/wake", {
    env: ENV, resolve4: async () => ["10.1.2.3"], resolve6: async () => [],
  });
  assert.deepEqual(named.addresses, ["10.1.2.3"], "an armed name's private answers are the pinned set");
  await assert.rejects(
    resolveWakeTarget("https://bridge.lan/wake", { env: {}, resolve4: async () => ["10.1.2.3"], resolve6: async () => [] }),
    err => err instanceof WebhookError && /private or reserved IP/.test(err.message),
    "the same name unarmed refuses its private answers");
  await assert.rejects(
    resolveWakeTarget("http://bridge.lan/wake", { env: ENV, resolve4: async () => [], resolve6: async () => [] }),
    err => err instanceof WebhookError && /does not resolve/.test(err.message),
    "armed is not reachable: a dead name fails closed");
});

test("assertWakeTargetUrl: armed literal passes without DNS; armed dead name refuses 422-shaped; unarmed delegates strict", async () => {
  assert.equal(await assertWakeTargetUrl("http://127.0.0.1:8787/wake", { env: ENV }), "http://127.0.0.1:8787/wake");
  await assert.rejects(
    assertWakeTargetUrl("http://bridge.lan/wake", { env: ENV, lookup: async () => { throw new Error("ENOTFOUND"); } }),
    err => err instanceof WebhookError && err.code === "webhook_url_not_public");
  await assert.rejects(
    assertWakeTargetUrl("https://127.0.0.1:8787/wake", { env: {} }),
    err => err instanceof WebhookError && err.code === "webhook_url_not_public");
});

// ---- heartbeat surfaces -----------------------------------------------------

const T0 = 1_750_000_000_000;
function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at });
  t.after(() => { db.close(); delete process.env[WAKE_TARGET_ALLOWLIST_ENV]; });
  return { db, hb, at: () => at };
}

test("heartbeat: armed push target and wakeUrl register; unarmed keep the ruling", t => {
  const { hb } = unit(t);
  process.env[WAKE_TARGET_ALLOWLIST_ENV] = "127.0.0.1";
  const { host } = hb.heartbeat({ agentId: "ai_bridge", hostId: "h1", mode: "wakeable",
    wakeUrl: "http://127.0.0.1:8787/wake",
    pushNotification: { url: "http://127.0.0.1:8787/push", token: "plug-b5" } });
  assert.equal(host.wakeUrl, "http://127.0.0.1:8787/wake", "armed wakeUrl stored");
  delete process.env[WAKE_TARGET_ALLOWLIST_ENV];
  assert.throws(() => hb.heartbeat({ agentId: "ai_bridge", hostId: "h2", mode: "wakeable",
    wakeUrl: "http://127.0.0.1:8787/wake" }),
    err => err instanceof HeartbeatError && err.status === 422 && /invalid wakeUrl/.test(err.message),
    "unarmed: the loopback wakeUrl stays refused on the API door");
  assert.throws(() => hb.heartbeat({ agentId: "ai_bridge", hostId: "h3", mode: "wakeable",
    pushNotification: { url: "http://127.0.0.1:8787/push", token: "plug-b5" } }),
    err => err instanceof HeartbeatError && err.status === 422 && /pushNotification.url/.test(err.message),
    "unarmed: the loopback push target stays refused");
});

test("assertPushDns: armed literal resolves; unarmed refuses; phantom refuses", async t => {
  const { hb } = unit(t);
  process.env[WAKE_TARGET_ALLOWLIST_ENV] = "127.0.0.1";
  await hb.assertPushDns("http://127.0.0.1:8787/push");
  await assert.rejects(hb.assertPushDns("http://unresolvable.invalid/push"), /rejected/);
  delete process.env[WAKE_TARGET_ALLOWLIST_ENV];
  await assert.rejects(hb.assertPushDns("http://127.0.0.1:8787/push"), /rejected/);
});

test("deliverPush dials an armed loopback server end-to-end; unarmed never sends", async t => {
  const { hb } = unit(t);
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => { hits.push({ url: req.url, token: req.headers["x-room-notification-token"], body }); res.writeHead(200); res.end("ok"); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const target = `http://127.0.0.1:${port}/wake`;
  const delivery = { agentId: "ai_bridge", hostId: "h1", url: target, token: "plug-b5",
    eventType: "message.posted", roomId: "commons", id: "evt-1", ts: T0 };

  process.env[WAKE_TARGET_ALLOWLIST_ENV] = "127.0.0.1";
  const ok = await hb.deliverPush(delivery);
  assert.equal(ok.ok, true, "the armed doorbell dials the loopback bridge");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].token, "plug-b5", "the push token travels in the header, never the body");
  const pointer = JSON.parse(hits[0].body);
  assert.deepEqual(Object.keys(pointer).sort(), ["eventType", "id", "roomId", "ts"], "pointer-only body");

  delete process.env[WAKE_TARGET_ALLOWLIST_ENV];
  const refused = await hb.deliverPush(delivery);
  assert.equal(refused.ok, false, "unarmed: no dial");
  assert.equal(refused.classification, "dead");
  assert.equal(hits.length, 1, "the refused delivery never reached the server");
});

// ---- subscription surfaces ---------------------------------------------------

test("wake-only subscriptions may arm a loopback URL; mixed/* stay strict", async () => {
  process.env[WAKE_TARGET_ALLOWLIST_ENV] = "127.0.0.1";
  try {
    const url = "http://127.0.0.1:8787/wake";
    await assertSubscriptionWebhookUrl(url, { events: ["agent.wake"] });
    const mgr = createAgentWebhookSubscriptions({ store: new Map() });
    const view = mgr.subscribe({ agentId: "ai_bridge", url, events: ["agent.wake"], secret: "wake0-test-secret-16" });
    assert.equal(view.url, url);
    // A content-bearing or wildcard subscription to the same loopback
    // target stays refused: https shape passes, then the public gate
    // refuses (webhook_url_not_public); http shape refuses even earlier.
    await assert.rejects(assertSubscriptionWebhookUrl("https://127.0.0.1:8787/wake", { events: ["message.posted"] }),
      err => err instanceof WebhookSubscriptionError && err.code === "webhook_url_not_public");
    await assert.rejects(assertSubscriptionWebhookUrl("https://127.0.0.1:8787/wake", { events: ["*"] }),
      err => err instanceof WebhookSubscriptionError && err.code === "webhook_url_not_public",
      "a wildcard subscription also carries room content: stays strict");
    await assert.rejects(assertSubscriptionWebhookUrl(url, { events: ["message.posted"] }),
      err => err instanceof WebhookSubscriptionError && err.code === "invalid_subscription");
    assert.throws(() => mgr.subscribe({ agentId: "ai_bridge", url, events: ["message.posted"], secret: "wake0-test-secret-16" }),
      err => err instanceof WebhookSubscriptionError && err.code === "invalid_subscription");
  } finally { delete process.env[WAKE_TARGET_ALLOWLIST_ENV]; }
  await assert.rejects(assertSubscriptionWebhookUrl("https://127.0.0.1:8787/wake", { events: ["agent.wake"] }),
    err => err instanceof WebhookSubscriptionError && err.code === "webhook_url_not_public",
    "unarmed: even a wake-only subscription refuses loopback");
});

test("general webhooks are never relaxed", () => {
  process.env[WAKE_TARGET_ALLOWLIST_ENV] = "127.0.0.1";
  try {
    const wh = createWebhooks({ store: new Map() });
    assert.throws(() => wh.register({ webhookId: "w1", url: "http://127.0.0.1:8787/hook",
      events: ["message.posted"], secret: "sixteen-char-secret" }),
      err => err.name === "WebhookError", "the owner webhook path keeps the strict validator");
  } finally { delete process.env[WAKE_TARGET_ALLOWLIST_ENV]; }
});
