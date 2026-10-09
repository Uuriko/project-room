#!/usr/bin/env node
// WAVE-2000 G02 worker-7 fuzz: shard (index%50==6) of route handlers in server/http.mjs
// Handlers: GET /.well-known/oauth-authorization-server, POST /api/guest-agent-links/preview
const BASE = "http://127.0.0.1:45971";
const ORIGIN = "http://127.0.0.1:45971";

const results = [];
async function req(method, path, { headers = {}, body = null, rawBody = null, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const init = { method, headers: { ...headers }, signal: ctrl.signal };
  if (rawBody !== null) init.body = rawBody;
  else if (body !== null) { init.body = JSON.stringify(body); init.headers["content-type"] = init.headers["content-type"] || "application/json"; }
  const start = Date.now();
  try {
    const r = await fetch(BASE + path, init);
    const text = await r.text();
    clearTimeout(t);
    return { status: r.status, ms: Date.now() - start, body: text.slice(0, 300) };
  } catch (e) {
    clearTimeout(t);
    return { status: "ERROR", ms: Date.now() - start, body: String(e).slice(0, 200) };
  }
}
async function t(name, method, path, opts, expect) {
  const r = await req(method, path, opts);
  const ok = Array.isArray(expect) ? expect.includes(r.status) : r.status === expect;
  results.push({ name, expect, got: r.status, ms: r.ms, ok, body: r.body });
  console.log(`${ok ? "PASS" : "FAIL"} [${r.status} expect ${expect}] ${r.ms}ms ${name}${r.body && !ok ? " :: " + r.body.slice(0,120) : ""}`);
}

const ga = "ga1." + "A".repeat(43);      // well-formed but nonexistent
const share = "B".repeat(43);             // human-share shape -> wrong_link_kind

await t("wellknown GET", "GET", "/.well-known/oauth-authorization-server", {}, 200);
await t("wellknown GET+query", "GET", "/.well-known/oauth-authorization-server?x=1", {}, 200);
await t("wellknown HEAD", "HEAD", "/.well-known/oauth-authorization-server", {}, 404);
await t("wellknown POST", "POST", "/.well-known/oauth-authorization-server", { headers: { "content-type": "application/json" }, body: {} }, 404);
await t("wellknown trailing slash", "GET", "/.well-known/oauth-authorization-server/", {}, 404);
await t("wellknown uppercase", "GET", "/.WELL-KNOWN/oauth-authorization-server", {}, 404);

const P = "/api/guest-agent-links/preview";
const O = { headers: { origin: ORIGIN } };
await t("preview wellformed-nonexistent", "POST", P, { ...O, body: { linkToken: ga } }, 410);
await t("preview garbage-string", "POST", P, { ...O, body: { linkToken: "xyz" } }, 410);
await t("preview human-share-kind", "POST", P, { ...O, body: { linkToken: share } }, 422);
await t("preview missing key", "POST", P, { ...O, body: {} }, 422);
await t("preview extra key", "POST", P, { ...O, body: { linkToken: ga, extra: 1 } }, 422);
await t("preview null token", "POST", P, { ...O, body: { linkToken: null } }, 410);
await t("preview number token", "POST", P, { ...O, body: { linkToken: 5 } }, 410);
await t("preview array token", "POST", P, { ...O, body: { linkToken: ["ga1.x"] } }, 410);
await t("preview object token", "POST", P, { ...O, body: { linkToken: { a: 1 } } }, 410);
await t("preview bool token", "POST", P, { ...O, body: { linkToken: true } }, 410);
await t("preview huge token", "POST", P, { ...O, body: { linkToken: "ga1." + "A".repeat(200000) } }, 410);
await t("preview unicode token", "POST", P, { ...O, body: { linkToken: "ga1.\u{1F600}".repeat(10) } }, 410);
await t("preview no origin", "POST", P, { body: { linkToken: ga } }, 403);
await t("preview wrong origin", "POST", P, { headers: { origin: "https://evil.example" }, body: { linkToken: ga } }, 403);
await t("preview no content-type", "POST", P, { headers: { origin: ORIGIN }, rawBody: '{"linkToken":"x"}' }, 415);
await t("preview text/plain", "POST", P, { headers: { origin: ORIGIN, "content-type": "text/plain" }, rawBody: '{"linkToken":"x"}' }, 415);
await t("preview empty body", "POST", P, { ...O, rawBody: "" }, 400);
await t("preview malformed json", "POST", P, { ...O, rawBody: '{"linkToken":' }, 400);
await t("preview array body", "POST", P, { ...O, rawBody: '[]' }, 400);
await t("preview null body", "POST", P, { ...O, rawBody: 'null' }, 400);
await t("preview string body", "POST", P, { ...O, rawBody: '"hi"' }, 400);
await t("preview number body", "POST", P, { ...O, rawBody: '42' }, 400);
await t("preview dup keys", "POST", P, { ...O, rawBody: '{"linkToken":"a","linkToken":"b"}' }, 410);
await t("preview oversized", "POST", P, { ...O, rawBody: JSON.stringify({ linkToken: "x".repeat(20000) }) }, 413);
await t("preview GET method", "GET", P, O, 404);

const fails = results.filter(r => !r.ok || r.status >= 500 || r.status === "ERROR");
console.log(`\n${results.length} cases, ${fails.length} failures/anomalies`);
import { writeFileSync } from "node:fs";
writeFileSync("/home/hatch/workspace/pr-wave2000-guild-02/worker-7/fuzz-results.json", JSON.stringify(results, null, 2));
