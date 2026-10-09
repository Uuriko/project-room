// WAVE-2000 G02 worker-22 fuzz battery — shard: POST /api/public-work/match (http.mjs:1730), POST /api/session (http.mjs:2601)
const BASE = "http://127.0.0.1:18731";
const ORIGIN = "http://127.0.0.1:18731";
const results = [];

async function req({ name, method = "POST", path, headers = {}, rawBody = undefined, jsonBody = undefined, expect }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 10s hang detection
  let status = null, bodyText = "", error = null;
  try {
    const init = { method, headers: { ...headers }, signal: ctrl.signal };
    if (rawBody !== undefined) init.body = rawBody;
    else if (jsonBody !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(jsonBody); }
    const res = await fetch(BASE + path, init);
    status = res.status;
    bodyText = (await res.text()).slice(0, 300);
  } catch (e) {
    error = e.name + ": " + e.message;
  } finally { clearTimeout(timer); }
  const ms = Date.now() - t0;
  const verdict = expect === undefined ? "OBSERVE" : (status === expect ? "PASS" : `UNEXPECTED(want ${expect})`);
  results.push({ name, method, path, status, ms, verdict, error, body: bodyText });
  console.log(`${verdict.padEnd(22)} ${String(status).padEnd(4)} ${ms}ms ${error ?? ""} :: ${name}`);
}

const S = { // POST /api/session — rate budget is 10/min; origin gate consumes none
  origin: ORIGIN,
};

async function main() {
  // ---- POST /api/session (http.mjs:2601) — fuzz first, watch the 10/min login rate budget ----
  await req({ name: "session GET (method guard)", method: "GET", path: "/api/session", expect: 404 });
  await req({ name: "session POST no Origin", path: "/api/session", jsonBody: { accessKey: "x" }, expect: 403 });
  await req({ name: "session POST wrong Origin", path: "/api/session", headers: { origin: "https://evil.example" }, jsonBody: { accessKey: "x" }, expect: 403 });
  await req({ name: "session POST Origin, no content-type", path: "/api/session", headers: S, rawBody: '{"accessKey":"x"}', expect: 415 });
  await req({ name: "session POST truncated JSON", path: "/api/session", headers: { ...S, "content-type": "application/json" }, rawBody: '{"accessKey":"x', expect: 400 });
  await req({ name: "session POST JSON array body", path: "/api/session", headers: { ...S, "content-type": "application/json" }, rawBody: '[1,2]', expect: 400 });
  await req({ name: "session POST {}", path: "/api/session", headers: S, jsonBody: {}, expect: 422 });
  await req({ name: "session POST accessKey non-string", path: "/api/session", headers: S, jsonBody: { accessKey: 123 }, expect: 422 });
  await req({ name: "session POST accessKey null", path: "/api/session", headers: S, jsonBody: { accessKey: null }, expect: 422 });
  await req({ name: "session POST bogus key", path: "/api/session", headers: S, jsonBody: { accessKey: "bogus-key-xyz-123" }, expect: 401 });
  await req({ name: "session POST empty accessKey", path: "/api/session", headers: S, jsonBody: { accessKey: "" } });
  await req({ name: "session POST 50k-char accessKey", path: "/api/session", headers: S, jsonBody: { accessKey: "k".repeat(50000) } });
  await req({ name: "session POST extra field", path: "/api/session", headers: S, jsonBody: { accessKey: "x", extra: 1 }, expect: 422 });
  await req({ name: "session POST unicode/control key", path: "/api/session", headers: S, jsonBody: { accessKey: "kéy null" } });
  await req({ name: "session PUT (wrong method)", method: "PUT", path: "/api/session", headers: S, jsonBody: { accessKey: "x" }, expect: 404 });

  // ---- POST /api/public-work/match (http.mjs:1730) — rate budget 60/min ----
  const M = "/api/public-work/match";
  await req({ name: "match GET (method guard)", method: "GET", path: M, expect: 405 });
  await req({ name: "match HEAD", method: "HEAD", path: M, expect: 405 });
  await req({ name: "match POST with query param", path: M + "?x=1", jsonBody: {}, expect: 422 });
  await req({ name: "match POST {} anonymous", path: M, jsonBody: {}, expect: 200 });
  await req({ name: "match POST skills not array", path: M, jsonBody: { skills: "x" }, expect: 422 });
  await req({ name: "match POST limit 6", path: M, jsonBody: { limit: 6 }, expect: 422 });
  await req({ name: "match POST limit 0", path: M, jsonBody: { limit: 0 }, expect: 422 });
  await req({ name: "match POST limit 1.5", path: M, jsonBody: { limit: 1.5 }, expect: 422 });
  await req({ name: "match POST limit '3' string", path: M, jsonBody: { limit: "3" }, expect: 422 });
  await req({ name: "match POST bad reward", path: M, jsonBody: { reward: "bitcoin" }, expect: 422 });
  await req({ name: "match POST reward cash (filters to empty)", path: M, jsonBody: { reward: "cash" }, expect: 200 });
  await req({ name: "match POST autoClaim string", path: M, jsonBody: { autoClaim: "yes" }, expect: 422 });
  await req({ name: "match POST autoClaim true, no secret", path: M, jsonBody: { autoClaim: true }, expect: 401 });
  await req({ name: "match POST autoClaim true, bogus bearer", path: M, headers: { authorization: "Bearer bogus-bogus" }, jsonBody: { autoClaim: true }, expect: 401 });
  await req({ name: "match POST invalid JSON", path: M, headers: { "content-type": "application/json" }, rawBody: '{"skills":[', expect: 400 });
  await req({ name: "match POST no content-type", path: M, rawBody: '{}', expect: 415 });
  await req({ name: "match POST oversized skill string", path: M, jsonBody: { skills: ["x".repeat(101)] }, expect: 422 });
  await req({ name: "match POST 21 skills", path: M, jsonBody: { skills: Array(21).fill("rust") }, expect: 422 });
  await req({ name: "match POST null skill", path: M, jsonBody: { skills: [null] }, expect: 422 });
  await req({ name: "match POST whitespace-only skill", path: M, jsonBody: { skills: ["   "] }, expect: 422 });
  await req({ name: "match POST control char skill", path: M, jsonBody: { skills: ["ab"] }, expect: 422 });
  await req({ name: "match POST requestId number", path: M, jsonBody: { requestId: 123 }, expect: 422 });
  await req({ name: "match POST requestId valid string", path: M, jsonBody: { requestId: "ab12" }, expect: 200 });
  await req({ name: "match POST leaseHours '6h'", path: M, jsonBody: { leaseHours: "6h" }, expect: 422 });
  await req({ name: "match POST leaseHours 0", path: M, jsonBody: { leaseHours: 0 }, expect: 422 });
  await req({ name: "match POST leaseHours 25", path: M, jsonBody: { leaseHours: 25 }, expect: 422 });
  await req({ name: "match POST leaseHours Infinity->null", path: M, headers: { "content-type": "application/json" }, rawBody: '{"leaseHours":null}', expect: 422 });
  await req({ name: "match POST unknown field", path: M, jsonBody: { unknownField: 1 }, expect: 422 });
  await req({ name: "match POST after number", path: M, jsonBody: { after: 123 }, expect: 422 });
  await req({ name: "match POST interests object", path: M, jsonBody: { interests: {} }, expect: 422 });
  await req({ name: "match POST nested-array skill", path: M, jsonBody: { skills: [["a"]] }, expect: 422 });
  await req({ name: "match POST array body", path: M, headers: { "content-type": "application/json" }, rawBody: '[]', expect: 400 });
  await req({ name: "match POST 1MB JSON object body (>16KiB cap)", path: M, headers: { "content-type": "application/json" }, rawBody: '{"x":"' + "y".repeat(1024 * 1024) + '"}', expect: 413 });
  await req({ name: "match POST valid preferences", path: M, jsonBody: { skills: ["rust", "wasm"], limit: 3 }, expect: 200 });
  await req({ name: "match POST bearer non-Bearer prefix", path: M, headers: { authorization: "bogus-bogus" }, jsonBody: {}, expect: 200 });
  await req({ name: "match DELETE", method: "DELETE", path: M, expect: 405 });

  const { writeFileSync } = await import("node:fs");
  writeFileSync("worker-22/fuzz-results.json", JSON.stringify(results, null, 2));
  const bad = results.filter(r => r.verdict.startsWith("UNEXPECTED") || r.error);
  console.log(`\nTOTAL=${results.length} UNEXPECTED=${bad.length}`);
}

main();
