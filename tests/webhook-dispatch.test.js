// Unit tests for the signed webhook dispatch engine
// (server/webhook-dispatch.mjs, RC-2026-09-19-064). Pure: no I/O, no
// network — the fetch implementation is injected into postDelivery.
import test from "node:test";
import assert from "node:assert/strict";
import {
  signDelivery, verifyDeliverySignature, isFresh, deliveryEnvelope, deliveryHeaders,
  classifyHttpStatus, postDelivery, pinnedDispatchPost, backoffDelayMs, REPLAY_TOLERANCE_MS,
  MAX_DELIVERY_ATTEMPTS, DELIVERY_TIMEOUT_MS, MAX_REDIRECT_HOPS, WebhookDispatchError,
} from "../server/webhook-dispatch.mjs";
import { createServer } from "node:http";

const SECRET = "signing-secret-0123456789abcdef";
const DELIVERY = { deliveryId: "del_abc123", eventType: "message.posted", issuedAt: 1_700_000_000_000, data: { messageId: "m1" } };
// QA-Sec 2026-09-19: postDelivery re-validates the target (incl. DNS) before
// every POST, so tests inject a resolver that answers "public" for any name.
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const privateDns = { resolve4: async () => ["127.0.0.1"], resolve6: async () => [] };
const nxDns = { resolve4: async () => { const e = new Error("queryA ENOTFOUND"); e.code = "ENOTFOUND"; throw e; },
  resolve6: async () => { const e = new Error("queryAaaa ENOTFOUND"); e.code = "ENOTFOUND"; throw e; } };
const postArgs = extra => ({ fetchImpl: async () => ({ status: 200, text: async () => "ok" }),
  url: "https://hooks.example.test/agent", envelope: {}, headers: {}, dnsResolvers: publicDns, ...extra });

test("signDelivery is deterministic, hex, and binds deliveryId + timestamp + data", () => {
  const a = signDelivery(SECRET, DELIVERY);
  const b = signDelivery(SECRET, DELIVERY);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(signDelivery(SECRET, { ...DELIVERY, deliveryId: "del_other" }), a);
  assert.notEqual(signDelivery(SECRET, { ...DELIVERY, issuedAt: DELIVERY.issuedAt + 1 }), a);
  assert.notEqual(signDelivery(SECRET, { ...DELIVERY, data: { messageId: "m2" } }), a);
  assert.notEqual(signDelivery("another-secret-0123456789abcdef", DELIVERY), a);
});

test("signDelivery rejects bad input without signing", () => {
  assert.throws(() => signDelivery("", DELIVERY), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, deliveryId: "" }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, issuedAt: 0 }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, issuedAt: 1.5 }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, data: null }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, data: "string" }), WebhookDispatchError);
});

test("verifyDeliverySignature round-trips and fails closed", () => {
  const signature = signDelivery(SECRET, DELIVERY);
  assert.equal(verifyDeliverySignature(SECRET, `sha256=${signature}`, DELIVERY), true);
  assert.equal(verifyDeliverySignature(SECRET, signature, DELIVERY), true); // bare hex also accepted
  assert.equal(verifyDeliverySignature("wrong-secret-0123456789abcdef", `sha256=${signature}`, DELIVERY), false);
  assert.equal(verifyDeliverySignature(SECRET, `sha256=${signature}`, { ...DELIVERY, data: { messageId: "tampered" } }), false);
  assert.equal(verifyDeliverySignature(SECRET, "sha256=00", DELIVERY), false);
  assert.equal(verifyDeliverySignature("", `sha256=${signature}`, DELIVERY), false);
  assert.equal(verifyDeliverySignature(SECRET, "", DELIVERY), false);
  assert.equal(verifyDeliverySignature(SECRET, `sha256=${signature}`, { ...DELIVERY, deliveryId: "" }), false);
});

test("isFresh enforces the 5-minute replay tolerance", () => {
  const now = 1_700_000_000_000;
  assert.equal(REPLAY_TOLERANCE_MS, 5 * 60 * 1000);
  assert.equal(isFresh(now, now), true);
  assert.equal(isFresh(now - REPLAY_TOLERANCE_MS, now), true);
  assert.equal(isFresh(now - REPLAY_TOLERANCE_MS - 1, now), false);
  assert.equal(isFresh(now + 60_000, now), true); // small clock skew tolerated
  assert.equal(isFresh(0, now), false);
  assert.equal(isFresh(NaN, now), false);
});

test("deliveryEnvelope carries the wire contract and is frozen", () => {
  const envelope = deliveryEnvelope({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "message.posted", issuedAt: 1_700_000_000_000, roomId: "commons", data: { a: 1 } });
  assert.equal(envelope.deliveryId, "del_1");
  assert.equal(envelope.subscriptionId, "sub_1");
  assert.equal(envelope.issuedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(envelope.roomId, "commons");
  assert.deepEqual(envelope.data, { a: 1 });
  assert.ok(Object.isFrozen(envelope));
  assert.equal(deliveryEnvelope({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "agent.wake", issuedAt: 1_700_000_000_000, data: {} }).roomId, null);
  assert.throws(() => deliveryEnvelope({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "x", issuedAt: 1, roomId: 42, data: {} }), WebhookDispatchError);
});

test("deliveryHeaders carries all signature headers", () => {
  const headers = deliveryHeaders({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "message.posted", issuedAt: 1_700_000_000_000, signature: "ab".repeat(32) });
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-webhook-delivery"], "del_1");
  assert.equal(headers["x-webhook-subscription"], "sub_1");
  assert.equal(headers["x-webhook-event"], "message.posted");
  assert.equal(headers["x-webhook-timestamp"], new Date(1_700_000_000_000).toISOString());
  assert.equal(headers["x-webhook-signature"], `sha256=${"ab".repeat(32)}`);
  assert.ok(Object.isFrozen(headers));
  assert.throws(() => deliveryHeaders({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "x", issuedAt: 1, signature: "not-hex" }), WebhookDispatchError);
});

test("classifyHttpStatus: 2xx delivered, 429/5xx/0 retry, other 4xx dead", () => {
  assert.equal(classifyHttpStatus(200), "delivered");
  assert.equal(classifyHttpStatus(201), "delivered");
  assert.equal(classifyHttpStatus(204), "delivered");
  assert.equal(classifyHttpStatus(429), "retry");
  assert.equal(classifyHttpStatus(500), "retry");
  assert.equal(classifyHttpStatus(503), "retry");
  assert.equal(classifyHttpStatus(0), "retry");
  assert.equal(classifyHttpStatus(400), "dead");
  assert.equal(classifyHttpStatus(404), "dead");
  assert.equal(classifyHttpStatus(422), "dead");
  assert.throws(() => classifyHttpStatus(-1), WebhookDispatchError);
});

test("postDelivery returns ok on 2xx without throwing", async () => {
  const seen = [];
  const result = await postDelivery({
    fetchImpl: async (url, opts) => {
      seen.push({ url, opts });
      return { status: 201, text: async () => "created" };
    },
    url: "https://hooks.example.test/agent",
    envelope: { deliveryId: "del_1" },
    headers: { "x-webhook-delivery": "del_1" },
    dnsResolvers: publicDns,
  });
  assert.deepEqual(result, { ok: true, status: 201, error: null });
  assert.equal(seen[0].url, "https://hooks.example.test/agent");
  assert.equal(seen[0].opts.method, "POST");
  assert.equal(JSON.parse(seen[0].opts.body).deliveryId, "del_1");
});

test("postDelivery classifies retryable failures and dead rejections", async () => {
  const retry = await postDelivery({ fetchImpl: async () => ({ status: 503, text: async () => "busy" }),
    url: "https://hooks.example.test/agent", envelope: {}, headers: {}, dnsResolvers: publicDns });
  assert.equal(retry.ok, false);
  assert.equal(retry.status, 503);
  assert.equal(retry.classification, "retry");
  assert.match(retry.error, /HTTP 503/);

  const dead = await postDelivery({ fetchImpl: async () => ({ status: 400, text: async () => "bad signature" }),
    url: "https://hooks.example.test/agent", envelope: {}, headers: {}, dnsResolvers: publicDns });
  assert.equal(dead.ok, false);
  assert.equal(dead.classification, "dead");
  assert.match(dead.error, /bad signature/);
});

test("postDelivery never throws on transport failure; errors are capped", async () => {
  const down = await postDelivery({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
    url: "https://hooks.example.test/agent", envelope: {}, headers: {}, dnsResolvers: publicDns });
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
  assert.equal(down.classification, "retry");
  assert.match(down.error, /ECONNREFUSED/);

  const timeout = await postDelivery({ fetchImpl: async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; },
    url: "https://hooks.example.test/agent", envelope: {}, headers: {}, dnsResolvers: publicDns });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /timed out/);

  const long = await postDelivery({ fetchImpl: async () => ({ status: 500, text: async () => "x".repeat(10_000) }),
    url: "https://hooks.example.test/agent", envelope: {}, headers: {}, dnsResolvers: publicDns });
  assert.ok(long.error.length <= 500);

  assert.rejects(() => postDelivery({ fetchImpl: "nope", url: "https://hooks.example.test/agent", envelope: {}, headers: {} }), WebhookDispatchError);
  assert.rejects(() => postDelivery(postArgs({ dnsResolvers: "nope" })), WebhookDispatchError);
});

test("backoffDelayMs doubles from 5s and caps at 10 minutes", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(backoffDelayMs), [5000, 10000, 20000, 40000, 80000]);
  assert.equal(backoffDelayMs(10), 600_000);
  assert.equal(backoffDelayMs(100), 600_000);
  assert.throws(() => backoffDelayMs(-1), WebhookDispatchError);
  assert.throws(() => backoffDelayMs(1.5), WebhookDispatchError);
});

test("dispatch constants match the claimed policy", () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 5);
  assert.equal(DELIVERY_TIMEOUT_MS, 10_000);
});

// --- QA-Sec 2026-09-19: dispatch-time SSRF guard ---------------------------

test("postDelivery dead-letters a target that resolves private at dispatch (DNS rebinding)", async () => {
  let fetched = 0;
  const result = await postDelivery(postArgs({
    fetchImpl: async () => { fetched++; return { status: 200, text: async () => "ok" }; },
    dnsResolvers: privateDns, // name was public at subscribe time, rebinding now
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.match(result.error, /private or reserved/);
  assert.equal(fetched, 0); // never touched the network
});

test("postDelivery dead-letters a private-IP literal mutated in after subscribing", async () => {
  let fetched = 0;
  const result = await postDelivery(postArgs({
    url: "https://127.0.0.1/hook",
    fetchImpl: async () => { fetched++; return { status: 200, text: async () => "ok" }; },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.equal(fetched, 0);
});

test("postDelivery dead-letters a downgraded (http) stored URL", async () => {
  let fetched = 0;
  const result = await postDelivery(postArgs({
    url: "http://hooks.example.test/hook",
    fetchImpl: async () => { fetched++; return { status: 200, text: async () => "ok" }; },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.equal(fetched, 0);
});

test("postDelivery retries when the hostname does not resolve (transient DNS)", async () => {
  let fetched = 0;
  const result = await postDelivery(postArgs({
    fetchImpl: async () => { fetched++; return { status: 200, text: async () => "ok" }; },
    dnsResolvers: nxDns,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "retry");
  assert.equal(fetched, 0);
});

test("postDelivery does not follow redirects to private targets", async () => {
  const seen = [];
  const result = await postDelivery(postArgs({
    fetchImpl: async url => {
      seen.push(url);
      if (url === "https://hooks.example.test/agent") {
        return { status: 307, headers: { get: name => (name === "location" ? "https://internal.example.test/callback" : null) }, text: async () => "" };
      }
      return { status: 200, headers: { get: () => null }, text: async () => "ok" };
    },
    dnsResolvers: {
      resolve4: async host => (host === "hooks.example.test" ? ["93.184.216.34"] : ["10.0.0.9"]),
      resolve6: async () => [],
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.match(result.error, /private or reserved/);
  assert.deepEqual(seen, ["https://hooks.example.test/agent"]); // the redirect was never followed
});

test("postDelivery refuses https->http redirect downgrades", async () => {
  const seen = [];
  const result = await postDelivery(postArgs({
    fetchImpl: async url => {
      seen.push(url);
      if (url === "https://hooks.example.test/agent") {
        return { status: 302, headers: { get: name => (name === "location" ? "http://hooks.example.test/plain" : null) }, text: async () => "" };
      }
      return { status: 200, headers: { get: () => null }, text: async () => "ok" };
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.match(result.error, /downgrade/);
  assert.deepEqual(seen, ["https://hooks.example.test/agent"]);
});

test("postDelivery follows same-scheme public redirects, re-validating each hop", async () => {
  const seen = [];
  const hops = ["https://hooks.example.test/agent", "https://cdn.example.test/final"];
  const result = await postDelivery(postArgs({
    fetchImpl: async url => {
      seen.push(url);
      if (url === hops[0]) {
        return { status: 301, headers: { get: name => (name === "location" ? hops[1] : null) }, text: async () => "" };
      }
      return { status: 200, headers: { get: () => null }, text: async () => "ok" };
    },
  }));
  assert.deepEqual(result, { ok: true, status: 200, error: null });
  assert.deepEqual(seen, hops);
});

test("postDelivery dead-letters redirect loops past the hop cap", async () => {
  let fetched = 0;
  const result = await postDelivery(postArgs({
    fetchImpl: async () => {
      fetched++;
      return { status: 302, headers: { get: name => (name === "location" ? "https://hooks.example.test/agent" : null) }, text: async () => "" };
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.match(result.error, /too many redirects/);
  assert.equal(fetched, MAX_REDIRECT_HOPS + 1);
});

test("postDelivery sends redirect: manual so fetch never follows on its own", async () => {
  const seen = [];
  await postDelivery(postArgs({
    fetchImpl: async (url, opts) => { seen.push(opts); return { status: 200, text: async () => "ok" }; },
  }));
  assert.equal(seen[0].redirect, "manual");
});

// --- M-1 fix (RC-2026-09-25): the dispatch connection is pinned -----------

test("pinnedDispatchPost connects to the checked address, never re-resolving the name", async t => {
  // A POST server on a loopback port stands in for the address that passed
  // the check. "rebind.invalid" can never resolve (RFC 6761), so a 200
  // proves the socket used the pinned address and did no second lookup.
  const seen = [];
  const page = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body, sig: req.headers["x-webhook-signature"] });
      res.writeHead(202, { "content-type": "text/plain" });
      res.end("accepted");
    });
  });
  await new Promise(resolve => page.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => page.close(resolve)));
  const port = page.address().port;
  const res = await pinnedDispatchPost(`http://rebind.invalid:${port}/hook`, ["127.0.0.1"], {
    headers: { "content-type": "application/json", "x-webhook-signature": "sha256=ab" },
    body: JSON.stringify({ deliveryId: "del_1" }),
    timeoutMs: 5000,
  });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "accepted");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].body, JSON.stringify({ deliveryId: "del_1" }));
  assert.equal(seen[0].sig, "sha256=ab");
  assert.match(seen[0].host, new RegExp(`^rebind\\.invalid:${port}$`), "Host header keeps the original name");
  // Control: with no checked address the transport refuses to connect.
  await assert.rejects(
    pinnedDispatchPost(`http://rebind.invalid:${port}/hook`, [], { headers: {}, body: "{}", timeoutMs: 5000 }),
    /no checked address/);
});

test("pinnedDispatchPost times out with a TimeoutError", async t => {
  const hanging = createServer(() => { /* never responds */ });
  await new Promise(resolve => hanging.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => hanging.close(resolve)));
  const port = hanging.address().port;
  const error = await pinnedDispatchPost(`http://rebind.invalid:${port}/hook`, ["127.0.0.1"],
    { headers: {}, body: "{}", timeoutMs: 200 }).then(
      () => { throw new Error("should have timed out"); },
      error => error);
  assert.equal(error.name, "TimeoutError");
});

test("postDelivery without fetchImpl still dead-letters a private target without touching the network", async () => {
  // No fetchImpl: the pinned transport is selected, but the dispatch-time
  // check rejects the target first, so no socket is ever opened.
  const result = await postDelivery({
    url: "https://[64:ff9b::a9fe:a9fe]/hook", // H-1 vector: NAT64 metadata
    envelope: {},
    headers: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.match(result.error, /private or reserved/);
});
