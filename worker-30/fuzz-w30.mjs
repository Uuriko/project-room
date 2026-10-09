// Worker 30 shard fuzzer. Targets:
//   idx29 (line 1925): GET/HEAD /join.html | /room/join.html  -> 301 redirect
//   idx79 (line 2899): POST /api/agent-identities | /api/identity-create -> 201 mint
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 4330;
const TIMEOUT_MS = 8000;

function req({ method = "GET", path = "/", headers = {}, body = undefined, rawBody = undefined }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    const r = http.request({ host: HOST, port: PORT, method, path, headers, timeout: TIMEOUT_MS }, (res) => {
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, ms: Date.now() - t0,
          body: Buffer.concat(chunks).toString("utf8").slice(0, 400) });
      });
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: "TIMEOUT", ms: Date.now() - t0, body: "" }); });
    r.on("error", (e) => resolve({ status: `ERR:${e.code || e.message}`, ms: Date.now() - t0, body: "" }));
    if (rawBody !== undefined) r.write(rawBody);
    else if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

const results = [];
async function run(name, target, spec, expect) {
  const r = await req(spec);
  const flag = (String(r.status).startsWith("5") || r.status === "TIMEOUT" || String(r.status).startsWith("ERR")) ? "ANOMALY"
    : (expect !== undefined && r.status !== expect) ? "WRONG-STATUS" : "ok";
  results.push({ target, name, method: spec.method || "GET", path: spec.path, expect, ...r, verdict: flag });
  if (flag !== "ok") console.log(JSON.stringify({ target, name, path: spec.path, expect, status: r.status, ms: r.ms, head: r.body.slice(0, 160), verdict: flag }));
}

// ---------- Target A: /join.html redirect ----------
const A = "idx29 /join.html";
await run("get-join.html", A, { path: "/join.html" }, 301);
await run("head-join.html", A, { method: "HEAD", path: "/join.html" }, 301);
await run("get-room-join.html", A, { path: "/room/join.html" }, 301);
await run("get-join.html-query", A, { path: "/join.html?next=/room/abc&x=1" }, 301);
await run("get-join.html-xss-query", A, { path: "/join.html?next=%3Cscript%3Ealert(1)%3C/script%3E" }, 301);
await run("post-join.html", A, { method: "POST", path: "/join.html", headers: { "content-type": "application/json" }, body: {} }, undefined);
await run("put-join.html", A, { method: "PUT", path: "/join.html" }, undefined);
await run("delete-join.html", A, { method: "DELETE", path: "/join.html" }, undefined);
await run("get-join-html-case", A, { path: "/JOIN.HTML" }, undefined);
await run("get-join.html-trailing", A, { path: "/join.html/" }, undefined);
await run("get-join-html-double-ext", A, { path: "/join.html.html" }, 301);
await run("get-room-join.html-query", A, { path: "/room/join.html?a=b" }, 301);
await run("get-join.html-fragment-ish", A, { path: "/join.html?%0d%0aX-Injected:%201" }, 301);

// ---------- Target B: POST /api/agent-identities ----------
const B = "idx79 POST /api/agent-identities";
const J = { "content-type": "application/json" };
await run("empty-body", B, { method: "POST", path: "/api/agent-identities", headers: J, body: "" }, 422);
await run("no-body-no-ct", B, { method: "POST", path: "/api/agent-identities" }, 422);
await run("invalid-json", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: "{not json" }, undefined);
await run("json-array-body", B, { method: "POST", path: "/api/agent-identities", headers: J, body: [1, 2] }, undefined);
await run("json-string-body", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: '"hello"' }, undefined);
await run("json-number-body", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: "42" }, undefined);
await run("json-bool-body", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: "true" }, undefined);
await run("json-null-body", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: "null" }, 422);
await run("valid-minimal", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "fuzz-agent" } }, 201);
await run("valid-alias-path", B, { method: "POST", path: "/api/identity-create", headers: J, body: { displayName: "fuzz-agent2" } }, 201);
await run("missing-displayName", B, { method: "POST", path: "/api/agent-identities", headers: J, body: {} }, 422);
await run("displayName-number", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: 42 } }, 422);
await run("displayName-null", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: null } }, 422);
await run("displayName-object", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: { a: 1 } } }, 422);
await run("displayName-array", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: ["x"] } }, 422);
await run("displayName-empty-string", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "" } }, undefined);
await run("extra-field", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", evil: 1 } }, 422);
await run("proto-pollution", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: '{"displayName":"x","__proto__":{"pwned":1}}' }, undefined);
await run("dup-keys", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: '{"displayName":"a","displayName":42}' }, 422);
await run("deep-nest", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: '{"displayName":"x","n":' + "{\"a\":".repeat(5000) + "1" + "}".repeat(5000) + "}" }, undefined);
await run("proof-valid", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", proof: "a".repeat(43) } }, 201);
await run("proof-44chars", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", proof: "a".repeat(44) } }, 422);
await run("proof-bad-chars", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", proof: "a b!" } }, 422);
await run("proof-empty", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", proof: "" } }, 422);
await run("proof-nonstring", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", proof: 123 } }, 422);
await run("recoverable-no-bearer", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", recoverable: true } }, 401);
await run("recoverable-false", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", recoverable: false } }, 422);
await run("recoverable-string", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x", recoverable: "yes" } }, 422);
await run("recoverable-with-bearer", B, { method: "POST", path: "/api/agent-identities", headers: { ...J, authorization: "Bearer <redacted>" }, body: { displayName: "x", recoverable: true } }, undefined);
await run("huge-displayName", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "x".repeat(200000) } }, undefined);
await run("huge-body-10mb", B, { method: "POST", path: "/api/agent-identities", headers: J, rawBody: '{"displayName":"' + "x".repeat(10 * 1024 * 1024) + '"}' }, undefined);
await run("unicode-displayName", B, { method: "POST", path: "/api/agent-identities", headers: J, body: { displayName: "🦕 agent \u0000 null" } }, undefined);
await run("text-plain-json", B, { method: "POST", path: "/api/agent-identities", headers: { "content-type": "text/plain" }, rawBody: '{"displayName":"x"}' }, undefined);
await run("get-on-mint", B, { method: "GET", path: "/api/agent-identities" }, 405);
await run("put-on-mint", B, { method: "PUT", path: "/api/agent-identities", headers: J, body: {} }, 405);
await run("delete-on-mint", B, { method: "DELETE", path: "/api/agent-identities" }, 405);
await run("options-on-mint", B, { method: "OPTIONS", path: "/api/agent-identities" }, undefined);
await run("trace-on-mint", B, { method: "TRACE", path: "/api/agent-identities" }, undefined);

const weird = results.filter((r) => r.verdict !== "ok");
console.log(`\n=== ${results.length} cases, ${weird.length} anomalies ===`);
for (const w of weird) console.log(JSON.stringify(w));
