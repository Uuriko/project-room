// RC-2026-09-19-087 (R2-004, P1): webhook URL SSRF guard. validateWebhookUrl
// must reject anything that can only be internal — cloud metadata, loopback,
// localhost, link-local, RFC1918/ULA — at subscribe time, before the URL is
// stored. Fuzzed cases from the QA report plus disguise variants.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateWebhookUrl,
  assertWebhookHostDnsPublic,
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
