// Workers resolve webhook names through DNS-over-HTTPS before subscribe
// and before delivery. A private answer is refused. A resolution failure
// is retried on delivery and refused at subscribe time.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("workerd refuses a private webhook answer and retries a resolution failure", async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import { assertSubscriptionWebhookUrl } from "../server/agent-webhook-subscriptions.mjs";
        import { postDelivery } from "../server/webhook-dispatch.mjs";
        import { isWorkersRuntime } from "../server/ip-blocklist.mjs";

        function doh(addresses, fail) {
          return async (requestUrl) => {
            if (fail) throw new Error("dns unavailable");
            const type = new URL(requestUrl).searchParams.get("type");
            const data = type === "A" ? addresses : [];
            return { ok: true, json: async () => ({ Status: 0, Answer: data.map(address => ({ type: 1, TTL: 60, data: address })) }) };
          };
        }

        const stored = [];
        export default {
          async fetch(request) {
            const url = new URL(request.url);
            if (!isWorkersRuntime()) return Response.json({ workers: false, ua: navigator.userAgent }, { status: 500 });
            if (url.pathname === "/subscribe") {
              const answer = url.searchParams.get("answer");
              const host = url.searchParams.get("host");
              try {
                const accepted = await assertSubscriptionWebhookUrl("https://" + host + "/path", { dohFetch: doh([answer], url.searchParams.get("fail") === "1") });
                stored.push(accepted);
                return Response.json({ ok: true, stored: stored.length });
              } catch (error) {
                return Response.json({ ok: false, code: error.code, status: error.status, stored: stored.length });
              }
            }
            const host = url.searchParams.get("host");
            const result = await postDelivery({
              url: "https://" + host + "/hook",
              envelope: { ping: true },
              headers: {},
              dnsResolvers: { dohFetch: doh(url.searchParams.get("fail") === "1" ? [] : ["10.1.2.3"], url.searchParams.get("fail") === "1") },
              fetchImpl: async () => ({ status: 204, text: async () => "", headers: { get: () => null } }),
            });
            return Response.json({ ok: result.ok, classification: result.classification, error: result.error ?? null, stored: stored.length });
          }
        };
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "js",
    },
    bundle: true, write: false, format: "esm", platform: "neutral",
    external: ["node:*", "cloudflare:*"],
  });
  const mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
  });
  try {
    const origin = "http://localhost";
    const privateAnswer = await (await mf.dispatchFetch(origin + "/subscribe?host=" + "hook-private.example" + "&answer=10.1.2.3")).json();
    assert.equal(privateAnswer.ok, false);
    assert.equal(privateAnswer.code, "webhook_url_not_public");
    assert.equal(privateAnswer.status, 422);
    assert.equal(privateAnswer.stored, 0);
    const loopback = await (await mf.dispatchFetch(origin + "/subscribe?host=" + "hook-loop.example" + "&answer=127.0.0.1")).json();
    assert.equal(loopback.code, "webhook_url_not_public");
    assert.equal(loopback.stored, 0);
    const unresolved = await (await mf.dispatchFetch(origin + "/subscribe?host=" + "hook-missing.example" + "&fail=1")).json();
    assert.equal(unresolved.code, "webhook_url_not_public");
    assert.equal(unresolved.stored, 0);
    const dead = await (await mf.dispatchFetch(origin + "/deliver?host=" + "deliver-private.example")).json();
    assert.equal(dead.ok, false);
    assert.equal(dead.classification, "dead");
    const retry = await (await mf.dispatchFetch(origin + "/deliver?host=" + "deliver-missing.example" + "&fail=1")).json();
    assert.equal(retry.ok, false);
    assert.equal(retry.classification, "retry");
  } finally {
    await mf.dispose();
  }
});
