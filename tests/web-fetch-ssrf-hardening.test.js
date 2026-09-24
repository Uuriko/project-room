// SSRF hardening follow-up to the #803 review
// (https://github.com/Uuriko/project-room/pull/803#issuecomment-5804719913):
// DNS fail-closed, connection pinning against rebinding, IPv4 embedded in
// IPv6 (NAT64, 6to4, v4-compatible, Teredo), and the loopback env switch
// only counting inside a test context. Each case has a valid control and a
// targeted negative. No external network: resolvers are injected.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  ipLiteralBlocked, assertPublicHost, resolveFetchTarget, pinnedLookup,
  fetchPage, pinnedRequest, webFetchTestContext, WebFetchError,
} from "../server/web-fetch.mjs";

const withEnv = async (vars, fn) => {
  const previous = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const isCode = (status, code) => error => error instanceof WebFetchError && error.status === status && error.code === code;

test("IPv4 embedded in IPv6 inherits the IPv4 verdict", () => withEnv({ WEB_FETCH_ALLOW_LOOPBACK: undefined }, () => {
  const blocked = [
    "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", // NAT64 -> 10/8, 127/8, metadata
    "2002:a00:1::", "2002:7f00:1::1", "2002:a9fe:a9fe::", // 6to4 -> 10.0.0.1, 127.0.0.1, 169.254.169.254
    "::10.0.0.1", "::a00:1", "::127.0.0.1", "::169.254.169.254", // v4-compatible
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "64:ff9b:1::1", // local-use NAT64
    "::ffff:10.0.0.1", "::", "::1",
  ];
  for (const ip of blocked) assert.equal(ipLiteralBlocked(ip), true, ip);
  const allowed = ["64:ff9b::808:808", "64:ff9b::8.8.8.8", "2002:808:808::", "::8.8.8.8", "::ffff:8.8.8.8", "2001:4860:4860::8888"];
  for (const ip of allowed) assert.equal(ipLiteralBlocked(ip), false, ip);
}));

test("DNS failure fails closed on Node; a public answer passes", async () => {
  const failing = async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); };
  const empty = async () => [];
  await assert.rejects(assertPublicHost("nx.example", { resolve: failing }), isCode(502, "fetch_failed"));
  await assert.rejects(assertPublicHost("nx.example", { resolve: empty }), isCode(502, "fetch_failed"));
  assert.deepEqual(await assertPublicHost("ok.example", { resolve: async () => ["93.184.216.34"] }), ["93.184.216.34"]);
});

test("any private or malformed answer blocks the host", async () => {
  for (const answers of [["93.184.216.34", "10.0.0.1"], ["64:ff9b::a00:1"], ["2002:7f00:1::"], ["not-an-ip"]]) {
    await assert.rejects(assertPublicHost("mixed.example", { resolve: async () => answers }), isCode(403, "blocked_host"), JSON.stringify(answers));
  }
});

test("literal IPs skip DNS and are their own pinned address", async () => {
  const resolve = async () => { throw new Error("resolver must not be called for a literal"); };
  assert.deepEqual(await assertPublicHost("93.184.216.34", { resolve }), ["93.184.216.34"]);
  const target = await resolveFetchTarget("http://93.184.216.34/x", { resolve });
  assert.deepEqual(target, { url: "http://93.184.216.34/x", addresses: ["93.184.216.34"] });
});

test("pinnedLookup answers only with checked addresses, whatever name is asked", async () => {
  const lookup = pinnedLookup(["93.184.216.34", "2606:2800:220:1::1"]);
  const one = await new Promise((resolve, reject) => lookup("rebound.example", {}, (e, a, f) => e ? reject(e) : resolve([a, f])));
  assert.deepEqual(one, ["93.184.216.34", 4]);
  const all = await new Promise((resolve, reject) => lookup("127.0.0.1.nip.io", { all: true }, (e, a) => e ? reject(e) : resolve(a)));
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }]);
  const none = pinnedLookup([]);
  await assert.rejects(new Promise((resolve, reject) => none("x", {}, e => e ? reject(e) : resolve())), /no checked address/);
});

test("rebinding: the pinned transport connects to the checked address, never re-resolving the name", async t => {
  // A page server on a loopback port stands in for the address that passed
  // the check. "rebind.invalid" can never resolve (RFC 6761), so a 200 proves
  // the socket used the pinned address and did no second lookup.
  const page = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<p>host=${req.headers.host}</p>`); });
  await new Promise(resolve => page.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => page.close(resolve)));
  const port = page.address().port;
  const res = await pinnedRequest(`http://rebind.invalid:${port}/`, ["127.0.0.1"], { signal: AbortSignal.timeout(5000), headers: {} });
  assert.equal(res.status, 200);
  const text = await new Response(res.body).text();
  assert.match(text, new RegExp(`host=rebind\\.invalid:${port}`), "Host header keeps the original name");
  assert.equal(res.headers.get("content-type"), "text/html");
  // Control: with no checked address the transport refuses to connect.
  await assert.rejects(pinnedRequest(`http://rebind.invalid:${port}/`, [], { signal: AbortSignal.timeout(5000), headers: {} }), /no checked address/);
});

test("fetchPage resolves each hop exactly once, through the check", async () => {
  let calls = 0;
  const resolve = async () => { calls += 1; return ["10.0.0.5"]; };
  await assert.rejects(fetchPage("http://internal.example/", { resolve }), isCode(403, "blocked_host"));
  assert.equal(calls, 1);
});

test("loopback flag only counts inside a test context", async () => {
  assert.equal(webFetchTestContext(), true, "node --test sets NODE_TEST_CONTEXT");
  await withEnv({ WEB_FETCH_ALLOW_LOOPBACK: "1" }, () => assert.equal(ipLiteralBlocked("127.0.0.1"), false));
  await withEnv({ WEB_FETCH_ALLOW_LOOPBACK: "1", NODE_TEST_CONTEXT: undefined, NODE_ENV: "production" }, () => {
    assert.equal(webFetchTestContext(), false);
    assert.equal(ipLiteralBlocked("127.0.0.1"), true, "flag ignored outside a test context");
    assert.equal(ipLiteralBlocked("::1"), true);
  });
});
