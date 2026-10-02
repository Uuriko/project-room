// QA2 finding P2-8. Agent webhook subscriptions must refuse a hostname
// that resolves into blocked address space, and delivery must refuse it
// again (including after a redirect) and journal that refusal once.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { assertSubscriptionWebhookUrl, WebhookSubscriptionError } from "../server/agent-webhook-subscriptions.mjs";
import { postDelivery } from "../server/webhook-dispatch.mjs";

const BLOCKED = [
  ["loopback.example", ["127.0.0.1"]],
  ["rfc1918.example", ["10.2.3.4"]],
  ["linklocal.example", ["169.254.169.254"]],
  ["v6loop.example", ["::1"]],
  ["mapped.example", ["::ffff:127.0.0.1"]],
  ["thisnet.example", ["0.1.2.3"]],
  ["cgnat.example", ["100.64.1.1"]],
  ["ula.example", ["fc00::1"]],
  ["v6link.example", ["fe80::1"]],
  ["split.example", ["8.8.8.8", "10.0.0.1"]],
];

function asLookup(records) {
  const map = records;
  return async (host, options) => {
    assert.equal(options?.all, true);
    const found = map[host];
    if (!found) {
      const error = new Error(`ENOTFOUND ${host}`);
      error.code = "ENOTFOUND";
      throw error;
    }
    return found.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

function post(origin, path, body, secret) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

async function errorBody(res) {
  const body = await res.json();
  return { status: res.status, code: body.error?.code, message: body.error?.message ?? "" };
}

test("QA2 P2-8: webhook DNS stays on public addresses", async (t) => {
  const records = {
    "public.example": ["93.184.216.34"],
    "hop.example": ["93.184.216.34"],
    "meta.example": ["169.254.169.254"],
    "ok.example": ["8.8.8.8", "2001:4860:4860::8888"],
  };
  for (const [host, addresses] of BLOCKED) records[host] = addresses;
  const f = createAcceptanceFixture();
  f.store.agentPlugin.setWebhookLookup(asLookup(records));
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identity = f.store.identities.create("ssrf-dns");

  for (const [host] of BLOCKED) {
    const refused = await errorBody(await post(origin, "/api/agent-webhooks", {
      url: `https://${host}/hook`, events: ["message.posted"],
    }, identity.secret));
    assert.equal(refused.status, 422, host);
    assert.equal(refused.code, "webhook_url_not_public", host);
    assert.match(refused.message, /private or reserved/, host);
  }

  const metadata = await errorBody(await post(origin, "/api/agent-webhooks", {
    url: "https://metadata.google.internal/computeMetadata/v1/", events: ["message.posted"],
  }, identity.secret));
  assert.equal(metadata.status, 422);
  assert.equal(metadata.code, "webhook_url_not_public");
  assert.match(metadata.message, /metadata/);
  assert.equal(f.store.agentPlugin.listWebhooks(identity.identityId).length, 0);

  const created = await post(origin, "/api/agent-webhooks", {
    url: "https://public.example/hook", events: ["message.posted"],
  }, identity.secret);
  assert.equal(created.status, 201);
  const { subscriptionId } = await created.json();

  records["public.example"] = ["10.9.8.7"];
  let dialed = 0;
  f.store.agentPlugin.buildWebhookDelivery(subscriptionId, {
    eventType: "message.posted", data: { messageId: "m-rebind" },
  });
  const refusedDelivery = await f.store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async () => { dialed += 1; return { status: 200, text: async () => "ok", headers: { get: () => null } }; },
  });
  assert.equal(refusedDelivery.deadLettered, 1);
  assert.equal(refusedDelivery.retried, 0);
  assert.equal(dialed, 0);
  const [refusedRow] = f.store.agentPlugin.webhookJournal(subscriptionId);
  assert.equal(refusedRow.state, "dead_letter");
  assert.equal(refusedRow.attempts, 1);
  assert.match(refusedRow.error, /webhook_url_not_public/);
  assert.match(refusedRow.error, /not retried/);
  assert.match(refusedRow.error, /private or reserved/);
  const again = await f.store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async () => { dialed += 1; return { status: 200, text: async () => "ok", headers: { get: () => null } }; },
  });
  assert.equal(again.processed, 0);
  assert.equal(dialed, 0);
  assert.equal(f.store.agentPlugin.webhookJournal(subscriptionId)[0].attempts, 1);

  const hop = await (await post(origin, "/api/agent-webhooks", {
    url: "https://hop.example/hook", events: ["message.posted"],
  }, identity.secret)).json();
  const seen = [];
  f.store.agentPlugin.buildWebhookDelivery(hop.subscriptionId, {
    eventType: "message.posted", data: { messageId: "m-redirect" },
  });
  const redirected = await f.store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async (url) => {
      seen.push(url);
      return {
        status: 302,
        headers: { get: name => (name === "location" ? "https://meta.example/latest" : null) },
        text: async () => "",
      };
    },
  });
  assert.equal(redirected.deadLettered, 1);
  assert.deepEqual(seen, ["https://hop.example/hook"]);
  const [redirectRow] = f.store.agentPlugin.webhookJournal(hop.subscriptionId);
  assert.equal(redirectRow.state, "dead_letter");
  assert.match(redirectRow.error, /webhook_url_not_public/);
  assert.match(redirectRow.error, /not retried/);

  const ok = await (await post(origin, "/api/agent-webhooks", {
    url: "https://ok.example/hook", events: ["message.posted"],
  }, identity.secret)).json();
  const deliveredTo = [];
  f.store.agentPlugin.buildWebhookDelivery(ok.subscriptionId, {
    eventType: "message.posted", data: { messageId: "m-ok" },
  });
  const delivered = await f.store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async (url) => {
      deliveredTo.push(url);
      return { status: 204, headers: { get: () => null }, text: async () => "" };
    },
  });
  assert.equal(delivered.delivered, 1);
  assert.deepEqual(deliveredTo, ["https://ok.example/hook"]);
  const [okRow] = f.store.agentPlugin.webhookJournal(ok.subscriptionId);
  assert.equal(okRow.state, "delivered");
  assert.equal(okRow.error, null);

  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Cloudflare-Workers" }, configurable: true, writable: true,
  });
  try {
    let lookups = 0;
    const doh = answers => async (url) => {
      const type = new URL(url).searchParams.get("type");
      const data = type === "A" ? answers : [];
      return { ok: true, json: async () => ({ Status: 0, Answer: data.map(address => ({ type: 1, TTL: 30, data: address })) }) };
    };
    await assert.rejects(
      () => assertSubscriptionWebhookUrl("https://rebind.example/hook", {
        lookup: async () => { lookups += 1; return [{ address: "127.0.0.1", family: 4 }]; },
        dohFetch: doh(["10.1.2.3"]),
      }),
      error => error instanceof WebhookSubscriptionError && error.code === "webhook_url_not_public" && error.status === 422,
    );
    assert.equal(lookups, 0);
    const allowed = await assertSubscriptionWebhookUrl("https://public-hook.example/hook", { dohFetch: doh(["93.184.216.34"]) });
    assert.equal(allowed, "https://public-hook.example/hook");
    await assert.rejects(
      () => assertSubscriptionWebhookUrl("https://metadata.google.internal/computeMetadata/v1/"),
      error => error instanceof WebhookSubscriptionError && error.code === "webhook_url_not_public" && error.status === 422,
    );
    let fetches = 0;
    const refused = await postDelivery({
      url: "https://hooks.example.test/hook",
      envelope: {},
      headers: {},
      dnsResolvers: { dohFetch: doh(["127.0.0.1"]) },
      fetchImpl: async () => {
        fetches += 1;
        return { status: 200, text: async () => "ok", headers: { get: () => null } };
      },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.classification, "dead");
    assert.match(refused.error, /webhook_url_not_public/);
    assert.equal(fetches, 0);
    const unresolved = await postDelivery({
      url: "https://missing.example.test/hook",
      envelope: {},
      headers: {},
      dnsResolvers: { dohFetch: async () => { throw new Error("dns unavailable"); } },
      fetchImpl: async () => {
        fetches += 1;
        return { status: 200, text: async () => "ok", headers: { get: () => null } };
      },
    });
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.classification, "retry");
    assert.equal(fetches, 0);
    const blockedName = await postDelivery({
      url: "https://metadata.goog/computeMetadata/v1/",
      envelope: {},
      headers: {},
      fetchImpl: async () => {
        fetches += 1;
        return { status: 200, text: async () => "ok", headers: { get: () => null } };
      },
    });
    assert.equal(blockedName.ok, false);
    assert.equal(blockedName.classification, "dead");
    assert.match(blockedName.error, /webhook_url_not_public/);
    assert.equal(fetches, 0);
  } finally {
    if (prior) Object.defineProperty(globalThis, "navigator", prior);
  }
});
