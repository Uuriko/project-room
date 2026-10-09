// WAVE-2000 guild-02 worker-25 fuzz: shard routes
//  (a) GET /openapi.json  (server/http.mjs:1713)
//  (b) POST /api/share-links/join-agent (server/http.mjs:2536)
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createAgentIdentity } from "../client/room-agent.mjs";

const ORIGIN = process.env.FUZZ_ORIGIN || "http://127.0.0.1:49125";
const results = [];
const counted = { joinAgent: 0 }; // requests that pass checkOrigin -> hit rate()

async function req(name, path, opts = {}, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(ORIGIN + path, { ...opts, signal: ctrl.signal });
    const ms = Date.now() - started;
    let bodyText = "";
    try { bodyText = await res.text(); } catch { bodyText = "<unreadable>"; }
    const rec = { name, method: opts.method || "GET", path: String(path).slice(0, 80),
      status: res.status, ms, bodyLen: bodyText.length, bodyHead: bodyText.slice(0, 160),
      allow: res.headers.get("allow"), ctype: res.headers.get("content-type") };
    results.push(rec);
    return rec;
  } catch (e) {
    const rec = { name, path: String(path).slice(0, 80), ERROR: String(e).slice(0, 140) };
    results.push(rec);
    return rec;
  } finally { clearTimeout(t); }
}

const J = obj => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

// ---- mint a real agent identity for the join-agent gate ----
const sec = "pri_" + randomBytes(32).toString("base64url");
const identity = await createAgentIdentity(ORIGIN, "Fuzzer25", { identitySecret: sec });
const IDHDR = { Authorization: "Bearer " + sec, Origin: ORIGIN };
const OHDR = { Origin: ORIGIN };

console.log("identity minted:", identity.identityId ? "ok" : "FAIL");

// ---- route A: /openapi.json ----
await req("a1 GET", "/openapi.json");
await req("a2 HEAD", "/openapi.json", { method: "HEAD" });
await req("a3 GET alias", "/room/openapi.json");
await req("a4 POST", "/openapi.json", { method: "POST" });
await req("a5 PUT", "/openapi.json", { method: "PUT" });
await req("a6 DELETE", "/openapi.json", { method: "DELETE" });
await req("a7 OPTIONS", "/openapi.json", { method: "OPTIONS" });
await req("a8 query", "/openapi.json?x=1&y=2");
await req("a9 case", "/openapi.JSON");
await req("a10 trailing slash", "/openapi.json/");
await req("a11 double slash", "//openapi.json");
await req("a12 long query", "/openapi.json?x=" + "A".repeat(10000));
await req("a13 POST+body", "/openapi.json", J({ a: 1 }));
await req("a14 evil host", "/openapi.json", { headers: { Host: "evil.example.com" } });

// ---- route B: POST /api/share-links/join-agent ----
const P = "/api/share-links/join-agent";
const B = (name, bodyObj, headers = IDHDR, raw) => {
  counted.joinAgent++;
  const opts = raw !== undefined
    ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: raw }
    : { ...J(bodyObj), headers: { ...J(bodyObj).headers, ...headers } };
  return req(name, P, opts);
};
await req("b1 no auth no origin", P, J({}));                                        // checkOrigin reject, not counted
await req("b2 no auth wrong origin", P, { ...J({}), headers: { Origin: "https://evil.example.com" } }); // not counted
counted.joinAgent++; await req("b3 no auth", P, { ...J({}), headers: OHDR });      // 401
counted.joinAgent++; await req("b4 bad bearer shape", P, { ...J({}), headers: { ...OHDR, Authorization: "Bearer x" } }); // 401
counted.joinAgent++; await req("b5 lowercase bearer", P, { ...J({ linkToken: "nope", displayName: "F" }), headers: { ...OHDR, Authorization: "bearer " + sec } });
counted.joinAgent++; await req("b6 room token as identity", P, { ...J({}), headers: { ...OHDR, Authorization: "Bearer rak_" + "A".repeat(16) } }); // 401 room_token_not_identity
counted.joinAgent++; await req("b7 wrong content-type", P, { method: "POST", headers: IDHDR, body: "hello" }); // 415
await B("b8 invalid json", null, IDHDR, "{not json");
await B("b9 json array", null, IDHDR, "[1,2]");
await B("b10 empty object", {});
await B("b11 extra key", { linkToken: "x", displayName: "F", extra: 1 });
await B("b12 garbage token", { linkToken: "garbage-token-zzz", displayName: "Fuzzer" });
await B("b13 empty token", { linkToken: "", displayName: "Fuzzer" });
await B("b14 numeric token", { linkToken: 12345, displayName: "Fuzzer" });
await B("b15 null token", { linkToken: null, displayName: "Fuzzer" });
await B("b16 object displayName", { linkToken: "garbage", displayName: {} });
await B("b17 array displayName", { linkToken: "garbage", displayName: ["x"] });
await B("b18 81char displayName", { linkToken: "garbage", displayName: "x".repeat(81) });
await B("b19 blank displayName", { linkToken: "garbage", displayName: "   " });
await B("b20 80char displayName", { linkToken: "garbage-token-zzz", displayName: "A".repeat(80) });
await B("b21 unicode displayName", { linkToken: "garbage-token-zzz", displayName: "\u2713".repeat(80) });
await req("b22 GET method", P, { headers: OHDR });                                 // 405, not counted
counted.joinAgent++; await req("b23 oversized body", P, { ...J({ linkToken: "x".repeat(20000), displayName: "F" }), headers: IDHDR }); // 413

// ---- rate-limit probe: limit is 20/min on link-agent-join:<ip> ----
const prior = counted.joinAgent;
const rateOut = [];
for (let i = 0; i < 6; i++) {
  counted.joinAgent++;
  const r = await req(`rate${i + 1} (n=${prior + i + 1})`, P, { ...J({ linkToken: "rate-probe", displayName: "R" }), headers: IDHDR });
  rateOut.push({ i: i + 1, n: prior + i + 1, status: r.status });
}

// ---- validate openapi.json parses ----
const openapi = await (await fetch(ORIGIN + "/openapi.json")).json().catch(() => null);

writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ results, rateOut, counted, openapiKeys: openapi ? Object.keys(openapi) : null, openapiVersion: openapi?.openapi }, null, 1));
console.log(JSON.stringify({ counted, rateOut, openapiKeys: openapi ? Object.keys(openapi) : null }, null, 1));
