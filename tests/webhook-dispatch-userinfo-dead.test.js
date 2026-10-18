// Adjacent to #2549 (grok/webhook-url-credentials-1010): validateWebhookUrl now
// rejects userinfo, but checkDispatchTarget classified permanent validation
// failures as "retry" instead of "dead" — its hostile regex only matched
// /valid https/. A target that can never validate must dead-letter, not burn
// 5 backoff retries. Pure: fetch and DNS are injected.
//
// The userinfo cases exercise the #2549-adjacent instance; they run only when
// the validator rejects userinfo (#2549 merged). The over-length cases fail
// on origin/main today and pin the classification fix itself.
import test from "node:test";
import assert from "node:assert/strict";
import { postDelivery } from "../server/webhook-dispatch.mjs";
import { validateWebhookUrl } from "../server/outbound-webhooks.mjs";

const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const nxDns = { resolve4: async () => { const e = new Error("queryA ENOTFOUND"); e.code = "ENOTFOUND"; throw e; },
  resolve6: async () => { const e = new Error("queryAaaa ENOTFOUND"); e.code = "ENOTFOUND"; throw e; } };
const okFetch = async () => ({ status: 200, text: async () => "ok" });
const postArgs = extra => ({ fetchImpl: okFetch, url: "https://hooks.example.test/agent",
  envelope: {}, headers: {}, dnsResolvers: publicDns, ...extra });
const longUrl = "https://hooks.example.test/" + "a".repeat(1990);

let rejectsUserinfo = false;
try { validateWebhookUrl("https://u:p@hooks.example.test/"); } catch { rejectsUserinfo = true; }

test("postDelivery dead-letters a permanently invalid target instead of retrying it", async () => {
  let fetched = 0;
  const result = await postDelivery(postArgs({
    url: longUrl,
    fetchImpl: async () => { fetched++; return okFetch(); },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.equal(fetched, 0); // refused before any network use
});

test("postDelivery dead-letters a redirect hop to a permanently invalid target", async () => {
  const seen = [];
  const result = await postDelivery(postArgs({
    fetchImpl: async url => {
      seen.push(url);
      return seen.length === 1
        ? { status: 302,
          headers: { get: name => (String(name).toLowerCase() === "location" ? longUrl : null) },
          text: async () => "" }
        : okFetch();
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "dead");
  assert.deepEqual(seen, ["https://hooks.example.test/agent"]); // redirect target never fetched
});

test("postDelivery still retries transient DNS failures", async () => {
  const result = await postDelivery(postArgs({ dnsResolvers: nxDns }));
  assert.equal(result.ok, false);
  assert.equal(result.classification, "retry");
});

test("postDelivery dead-letters a stored URL that carries userinfo (never retries it)",
  { skip: !rejectsUserinfo }, async () => {
    let fetched = 0;
    const result = await postDelivery(postArgs({
      url: "https://ops:s3cret@hooks.example.test/hook",
      fetchImpl: async () => { fetched++; return okFetch(); },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.classification, "dead");
    assert.match(result.error, /without credentials/);
    assert.equal(fetched, 0);
  });

test("postDelivery dead-letters a redirect hop to a userinfo URL",
  { skip: !rejectsUserinfo }, async () => {
    const seen = [];
    const result = await postDelivery(postArgs({
      fetchImpl: async url => {
        seen.push(url);
        return seen.length === 1
          ? { status: 302,
            headers: { get: name => (String(name).toLowerCase() === "location"
              ? "https://ops:s3cret@hooks.example.test/x" : null) },
            text: async () => "" }
          : okFetch();
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.classification, "dead");
    assert.match(result.error, /without credentials/);
    assert.ok(seen.every(u => !u.includes("s3cret")), "the credentialed URL is never fetched");
  });
