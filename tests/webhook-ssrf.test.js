// RC-2026-09-19-087 (R2-004, P1): webhook URL SSRF guard. validateWebhookUrl
// must reject anything that can only be internal — cloud metadata, loopback,
// localhost, link-local, RFC1918/ULA — at subscribe time, before the URL is
// stored. Fuzzed cases from the QA report plus disguise variants.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateWebhookUrl,
  assertWebhookHostDnsPublic,
  resolveWebhookTarget,
  createWebhooks,
  WebhookError,
} from "../server/outbound-webhooks.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof WebhookError && error.code === code);
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof WebhookError && error.code === code);

test("SSRF: QA-report fuzzed cases are rejected", () => {
  // The exact cases from the QA report (R2-004).
  throwsCode(() => validateWebhookUrl("https://169.254.169.254/"), "invalid_webhook"); // cloud metadata
  throwsCode(() => validateWebhookUrl("https://localhost/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://127.0.0.1/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://[::1]/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://10.0.0.5/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://192.168.1.1/hook"), "invalid_webhook");
});

test("SSRF: localhost disguises are rejected", () => {
  throwsCode(() => validateWebhookUrl("https://LOCALHOST/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://localhost./hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://localhost:8443/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://foo.localhost/hook"), "invalid_webhook");
});

test("SSRF: IPv4 literal disguises are rejected", () => {
  throwsCode(() => validateWebhookUrl("https://2130706433/hook"), "invalid_webhook"); // 127.0.0.1 decimal
  throwsCode(() => validateWebhookUrl("https://0x7f.0.0.1/hook"), "invalid_webhook"); // hex
  throwsCode(() => validateWebhookUrl("https://0177.0.0.1/hook"), "invalid_webhook"); // octal
  throwsCode(() => validateWebhookUrl("https://127.1/hook"), "invalid_webhook"); // short form
  throwsCode(() => validateWebhookUrl("https://0.0.0.0/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://example.com@127.0.0.1/hook"), "invalid_webhook"); // userinfo trick
  throwsCode(() => validateWebhookUrl("https://172.16.0.9/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://172.31.255.255/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://100.64.0.1/hook"), "invalid_webhook"); // CGNAT
  throwsCode(() => validateWebhookUrl("https://224.0.0.1/hook"), "invalid_webhook"); // multicast
  throwsCode(() => validateWebhookUrl("https://169.254.169.254/latest/meta-data/iam/security-credentials/"), "invalid_webhook");
});

test("SSRF: IPv6 literals to internal space are rejected", () => {
  throwsCode(() => validateWebhookUrl("https://[0:0:0:0:0:0:0:1]/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("https://[::ffff:127.0.0.1]/hook"), "invalid_webhook"); // mapped loopback
  throwsCode(() => validateWebhookUrl("https://[::ffff:10.0.0.5]/hook"), "invalid_webhook"); // mapped RFC1918
  throwsCode(() => validateWebhookUrl("https://[fe80::1]/hook"), "invalid_webhook"); // link-local
  throwsCode(() => validateWebhookUrl("https://[fc00::1]/hook"), "invalid_webhook"); // ULA
  throwsCode(() => validateWebhookUrl("https://[fd12:3456::1]/hook"), "invalid_webhook"); // ULA
  throwsCode(() => validateWebhookUrl("https://[ff02::1]/hook"), "invalid_webhook"); // multicast
});

test("SSRF: public targets still pass", () => {
  assert.equal(validateWebhookUrl("https://example.com/hook"), "https://example.com/hook");
  assert.equal(validateWebhookUrl("https://hooks.example.com:8443/path?q=1"), "https://hooks.example.com:8443/path?q=1");
  // Public IP literals are not SSRF-able to internal infra (no DNS to
  // rebind), so they stay allowed.
  assert.equal(validateWebhookUrl("https://8.8.8.8/hook"), "https://8.8.8.8/hook");
  assert.equal(validateWebhookUrl("https://[2001:4860:4860::8888]/hook"), "https://[2001:4860:4860::8888]/hook");
});

test("SSRF: register() inherits the guard", () => {
  const hooks = createWebhooks();
  throwsCode(() => hooks.register({ webhookId: "evil", url: "https://169.254.169.254/", events: ["*"] }), "invalid_webhook");
  assert.equal(hooks.size(), 0); // nothing stored
  const ok = hooks.register({ webhookId: "w1", url: "https://hooks.example.com/hook", events: ["*"] });
  assert.equal(ok.url, "https://hooks.example.com/hook");
});

test("SSRF: pre-existing shape rejections still hold", () => {
  throwsCode(() => validateWebhookUrl("http://example.com/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("not-a-url"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl(""), "invalid_webhook");
  throwsCode(() => validateWebhookUrl(`https://example.com/${"x".repeat(2000)}`), "invalid_webhook");
});

test("DNS rebinding check: resolving to internal addresses is rejected", async () => {
  const internal4 = { resolve4: async () => ["10.0.0.5"], resolve6: async () => [] };
  await rejectsCode(assertWebhookHostDnsPublic("https://hooks.example.com/hook", internal4), "invalid_webhook");
  const internal6 = { resolve4: async () => [], resolve6: async () => ["::1"] };
  await rejectsCode(assertWebhookHostDnsPublic("https://hooks.example.com/hook", internal6), "invalid_webhook");
  const mixed = { resolve4: async () => ["93.184.216.34", "192.168.1.1"], resolve6: async () => [] };
  await rejectsCode(assertWebhookHostDnsPublic("https://hooks.example.com/hook", mixed), "invalid_webhook");
  const nxdomain = {
    resolve4: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
    resolve6: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
  };
  await rejectsCode(assertWebhookHostDnsPublic("https://hooks.example.com/hook", nxdomain), "invalid_webhook");
});

test("DNS rebinding check: public resolutions pass, literals skip DNS", async () => {
  const pub = { resolve4: async () => ["93.184.216.34"], resolve6: async () => ["2606:2800:220:1:248:1893:25c8:1946"] };
  assert.equal(await assertWebhookHostDnsPublic("https://hooks.example.com/hook", pub), "https://hooks.example.com/hook");
  // IP literals were already screened synchronously — the resolver is never consulted.
  const bomb = { resolve4: async () => { throw new Error("must not resolve"); }, resolve6: async () => { throw new Error("must not resolve"); } };
  assert.equal(await assertWebhookHostDnsPublic("https://8.8.8.8/hook", bomb), "https://8.8.8.8/hook");
  // A sync-rejected URL stays rejected through the async path too.
  await rejectsCode(assertWebhookHostDnsPublic("https://127.0.0.1/hook", pub), "invalid_webhook");
});

test("SSRF: v4-embedded IPv6 bypass vectors are rejected (H-1, RC-2026-09-25)", async () => {
  // Every one of these was ALLOWED by the old isPrivateIpv6 on main — a
  // deterministic SSRF bypass (e.g. NAT64-wrapped cloud metadata). The
  // guard now shares web-fetch's embedded-address extraction.
  const bypasses = [
    "https://[64:ff9b::a9fe:a9fe]/hook", // NAT64 for 169.254.169.254 (metadata)
    "https://[64:ff9b::a00:1]/hook", // NAT64 for 10.0.0.1 (RFC1918)
    "https://[64:ff9b::7f00:1]/hook", // NAT64 for 127.0.0.1 (loopback)
    "https://[64:ff9b::10.0.0.1]/hook", // NAT64, dotted-quad tail
    "https://[2002:a9fe:a9fe::]/hook", // 6to4 for 169.254.169.254
    "https://[2002:a00:1::]/hook", // 6to4 for 10.0.0.1
    "https://[2002:7f00:1::]/hook", // 6to4 for 127.0.0.1
    "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/hook", // Teredo (tunnels to arbitrary v4)
    "https://[2001::1]/hook", // Teredo prefix
    "https://[::a9fe:a9fe]/hook", // v4-compatible (deprecated) for 169.254.169.254
    "https://[::10.0.0.1]/hook", // v4-compatible for 10.0.0.1
    "https://[64:ff9b:1::1]/hook", // local-use NAT64 (RFC 8215)
  ];
  for (const url of bypasses) throwsCode(() => validateWebhookUrl(url), "invalid_webhook");
  // And through the DNS path: a name resolving to any of these is rejected.
  for (const answer of ["64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::a9fe:a9fe"]) {
    const resolvers = { resolve4: async () => [], resolve6: async () => [answer] };
    await rejectsCode(assertWebhookHostDnsPublic("https://hooks.example.com/hook", resolvers), "invalid_webhook");
  }
});

test("SSRF: public IPv6 and public-embedded vectors still pass (H-1)", () => {
  // NAT64/6to4/v4-compatible wrappers around PUBLIC v4 are not SSRF-able
  // to internal infra, so they stay allowed — same as the web-fetch path.
  assert.equal(validateWebhookUrl("https://[2001:4860:4860::8888]/hook"), "https://[2001:4860:4860::8888]/hook");
  assert.equal(validateWebhookUrl("https://[64:ff9b::808:808]/hook"), "https://[64:ff9b::808:808]/hook");
  assert.equal(validateWebhookUrl("https://[64:ff9b::8.8.8.8]/hook"), "https://[64:ff9b::8.8.8.8]/hook");
  assert.equal(validateWebhookUrl("https://[2002:808:808::]/hook"), "https://[2002:808:808::]/hook");
  assert.equal(validateWebhookUrl("https://[::8.8.8.8]/hook"), "https://[::8.8.8.8]/hook");
  assert.equal(validateWebhookUrl("https://[::ffff:8.8.8.8]/hook"), "https://[::ffff:8.8.8.8]/hook");
});

test("resolveWebhookTarget returns the checked addresses for pinning (M-1)", async () => {
  const pub = { resolve4: async () => ["93.184.216.34"], resolve6: async () => ["2606:2800:220:1:248:1893:25c8:1946"] };
  assert.deepEqual(await resolveWebhookTarget("https://hooks.example.com/hook", pub),
    { url: "https://hooks.example.com/hook", addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
  // IP literals skip DNS; the literal itself is the pinned address set.
  const bomb = { resolve4: async () => { throw new Error("must not resolve"); }, resolve6: async () => { throw new Error("must not resolve"); } };
  assert.deepEqual(await resolveWebhookTarget("https://[2001:4860:4860::8888]/hook", bomb),
    { url: "https://[2001:4860:4860::8888]/hook", addresses: ["2001:4860:4860::8888"] });
  // assertWebhookHostDnsPublic keeps its url-returning contract.
  assert.equal(await assertWebhookHostDnsPublic("https://hooks.example.com/hook", pub), "https://hooks.example.com/hook");
});
