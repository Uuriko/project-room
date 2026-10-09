// WAVE-2000 G02 worker-22 round 2 — edge cases for POST /api/public-work/match & POST /api/session
const BASE = "http://127.0.0.1:18731";
const ORIGIN = "http://127.0.0.1:18731";
const results = [];

async function req({ name, method = "POST", path, headers = {}, rawBody = undefined, jsonBody = undefined, expect }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let status = null, bodyText = "", error = null;
  try {
    const init = { method, headers: { ...headers }, signal: ctrl.signal };
    if (rawBody !== undefined) init.body = rawBody;
    else if (jsonBody !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(jsonBody); }
    const res = await fetch(BASE + path, init);
    status = res.status;
    bodyText = (await res.text()).slice(0, 200);
  } catch (e) { error = e.name + ": " + e.message; }
  finally { clearTimeout(timer); }
  const ms = Date.now() - t0;
  const verdict = expect === undefined ? "OBSERVE" : (status === expect ? "PASS" : `UNEXPECTED(want ${expect})`);
  results.push({ name, status, ms, verdict, error, body: bodyText });
  console.log(`${verdict.padEnd(22)} ${String(status).padEnd(4)} ${ms}ms ${error ?? ""} :: ${name}`);
}

async function main() {
  const M = "/api/public-work/match";
  const goodShape = "a".repeat(43); // matches bearer() token-shape regex
  await req({ name: "match POST unknown-but-wellformed secret", path: M, headers: { authorization: "Bearer " + goodShape }, jsonBody: {}, expect: 401 });
  await req({ name: "match POST lowercase 'bearer' scheme", path: M, headers: { authorization: "bearer " + goodShape }, jsonBody: {}, expect: 401 });
  await req({ name: "match POST rak_ prefix shape unknown", path: M, headers: { authorization: "Bearer rak_" + "b".repeat(20) }, jsonBody: {}, expect: 401 });
  await req({ name: "match POST duplicate query keys", path: M + "?a=1&a=2", jsonBody: {}, expect: 422 });
  await req({ name: "match POST empty query key", path: M + "?=x", jsonBody: {}, expect: 422 });
  await req({ name: "match POST 20 skills ok", path: M, jsonBody: { skills: Array(20).fill("rust") }, expect: 200 });
  await req({ name: "match POST limit 5 boundary", path: M, jsonBody: { limit: 5 }, expect: 200 });
  await req({ name: "match POST leaseHours 24 boundary", path: M, jsonBody: { leaseHours: 24 }, expect: 200 });
  await req({ name: "match POST leaseHours 0.5 ok", path: M, jsonBody: { leaseHours: 0.5 }, expect: 200 });
  await req({ name: "match POST leaseHours -1", path: M, jsonBody: { leaseHours: -1 }, expect: 422 });
  await req({ name: "match POST requestId '__proto__'", path: M, jsonBody: { requestId: "__proto__" }, expect: 422 });
  await req({ name: "match POST requestId 129 chars", path: M, jsonBody: { requestId: "x".repeat(129) }, expect: 422 });
  await req({ name: "match POST requestId starts with '-'", path: M, jsonBody: { requestId: "-abc" }, expect: 422 });
  await req({ name: "match POST after valid cursor format", path: M, jsonBody: { after: "abc123" }, expect: 200 });
  await req({ name: "match POST skill 100-char boundary", path: M, jsonBody: { skills: ["x".repeat(100)] }, expect: 200 });
  await req({ name: "match POST skill with DEL char", path: M, headers: { "content-type": "application/json" }, rawBody: '{"skills":["ab"]}', expect: 422 });
  await req({ name: "match POST duplicate skills", path: M, jsonBody: { skills: ["rust", "rust"] }, expect: 200 });
  await req({ name: "match POST empty string skill", path: M, jsonBody: { skills: [""] }, expect: 422 });
  await req({ name: "match POST null body fields", path: M, jsonBody: { skills: null, limit: null }, expect: 422 });
  await req({ name: "match POST charset content-type", path: M, headers: { "content-type": "application/json; charset=utf-8" }, rawBody: '{"limit":2}', expect: 200 });
  await req({ name: "match POST x-www-form-urlencoded", path: M, headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: "limit=2", expect: 415 });

  // /api/session extras (fresh rate budget window likely elapsed; retry on 429 is fine — note it)
  const S = "/api/session";
  await req({ name: "session POST charset content-type", path: S, headers: { origin: ORIGIN, "content-type": "application/json; charset=utf-8" }, rawBody: '{"accessKey":"bogus"}', expect: 401 });
  await req({ name: "session POST trailing slash path", path: S + "/", headers: { origin: ORIGIN }, jsonBody: { accessKey: "x" } });
  await req({ name: "session POST Origin uppercase host", path: S, headers: { origin: "HTTP://127.0.0.1:18731" }, jsonBody: { accessKey: "x" }, expect: 403 });
  await req({ name: "session POST Origin trailing slash", path: S, headers: { origin: ORIGIN + "/" }, jsonBody: { accessKey: "x" }, expect: 403 });
  await req({ name: "session POST empty body", path: S, headers: { origin: ORIGIN, "content-type": "application/json" }, rawBody: "", expect: 400 });
  await req({ name: "session POST body 'null'", path: S, headers: { origin: ORIGIN, "content-type": "application/json" }, rawBody: "null", expect: 400 });
  await req({ name: "session POST accessKey boolean", path: S, headers: { origin: ORIGIN }, jsonBody: { accessKey: true }, expect: 422 });
  await req({ name: "session POST deeply nested accessKey", path: S, headers: { origin: ORIGIN }, jsonBody: { accessKey: { v: 1 } }, expect: 422 });

  const { writeFileSync } = await import("node:fs");
  writeFileSync("worker-22/fuzz-results-2.json", JSON.stringify(results, null, 2));
  const bad = results.filter(r => r.verdict.startsWith("UNEXPECTED") || r.error);
  console.log(`\nTOTAL=${results.length} UNEXPECTED=${bad.length}`);
}
main();
