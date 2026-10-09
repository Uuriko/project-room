// WAVE-2000 G02 worker-46: fuzz shard routes
//   A: GET /api/auth/methods (line 2248)
//   B: GET /api/agent-rooms  (line 3112)
// Reports crash / hang / wrong-status.
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.W46_PORT || 4281);
const TIMEOUT_MS = 8000;

function raw(opts, body) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { resolve({ hang: true }); req.destroy(); }, TIMEOUT_MS);
    const req = http.request({ host: HOST, port: PORT, ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(t);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8", 0, 2000) });
      });
    });
    req.on("error", (e) => { clearTimeout(t); resolve({ error: e.message }); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const results = [];
async function t(name, opts, body, expect) {
  const r = await raw(opts, body);
  const got = r.hang ? "HANG" : (r.error ? `ERR:${r.error}` : r.status);
  const ok = expect === "any" || got === expect;
  results.push({ name, got, expect, ok, extra: r.status && r.status >= 500 ? r.body.slice(0, 300) : undefined });
}

const COOKIE = (process.env.W46_COOKIE_NAME || "account_session");
const run = async () => {
  // ---------- Route A: /api/auth/methods ----------
  await t("A1 no cookie GET", { path: "/api/auth/methods", method: "GET" }, undefined, 401);
  await t("A2 garbage cookie", { path: "/api/auth/methods", method: "GET", headers: { cookie: `${COOKIE}=deadbeef-not-a-session` } }, undefined, 401);
  await t("A3 long cookie", { path: "/api/auth/methods", method: "GET", headers: { cookie: `${COOKIE}=${"a".repeat(4000)}` } }, undefined, 401);
  await t("A4 cookie no value", { path: "/api/auth/methods", method: "GET", headers: { cookie: `${COOKIE}=` } }, undefined, 401);
  await t("A5 cookie with newline-ish", { path: "/api/auth/methods", method: "GET", headers: { cookie: `${COOKIE}=abc` } }, undefined, 401);
  await t("A6 POST no body", { path: "/api/auth/methods", method: "POST", headers: { "content-length": "0" } }, undefined, 405);
  await t("A7 PUT", { path: "/api/auth/methods", method: "PUT", headers: { "content-length": "0" } }, undefined, 405);
  await t("A8 DELETE", { path: "/api/auth/methods", method: "DELETE", headers: { "content-length": "0" } }, undefined, 405);
  await t("A9 PATCH", { path: "/api/auth/methods", method: "PATCH", headers: { "content-length": "0" } }, undefined, 405);
  await t("A10 HEAD (method gate is != GET, so 405 expected)", { path: "/api/auth/methods", method: "HEAD" }, undefined, 405);
  await t("A11 OPTIONS", { path: "/api/auth/methods", method: "OPTIONS" }, undefined, 405);
  await t("A12 query junk", { path: "/api/auth/methods?x=1&y[]=2", method: "GET" }, undefined, 401);
  await t("A13 trailing slash", { path: "/api/auth/methods/", method: "GET" }, undefined, "any");
  await t("A14 case variant", { path: "/api/auth/METHODS", method: "GET" }, undefined, "any");
  await t("A15 garbage header value", { path: "/api/auth/methods", method: "GET", headers: { "x-weird": "a".repeat(8192) } }, undefined, 401);
  await t("A16 duplicate cookie keys", { path: "/api/auth/methods", method: "GET", headers: { cookie: `${COOKIE}=x; ${COOKIE}=y` } }, undefined, 401);
  await t("A17 semicolon-in-cookie", { path: "/api/auth/methods", method: "GET", headers: { cookie: `${COOKIE}=a;b=c` } }, undefined, 401);
  await t("A18 POST with cookie+body", { path: "/api/auth/methods", method: "POST", headers: { "content-type": "application/json", "content-length": "7", cookie: `${COOKIE}=abc` } }, '{"a":1}', 405);
  await t("A19 huge query", { path: "/api/auth/methods?" + "q=".repeat(2000), method: "GET" }, undefined, "any");

  // ---------- Route B: /api/agent-rooms GET ----------
  await t("B1 no bearer", { path: "/api/agent-rooms", method: "GET" }, undefined, 401);
  await t("B2 garbage bearer", { path: "/api/agent-rooms", method: "GET", headers: { authorization: "Bearer nope" } }, undefined, 401);
  await t("B3 lowercase bearer scheme", { path: "/api/agent-rooms", method: "GET", headers: { authorization: "bearer nope" } }, undefined, 401);
  await t("B4 long bearer", { path: "/api/agent-rooms", method: "GET", headers: { authorization: "Bearer " + "z".repeat(4000) } }, undefined, 401);
  await t("B5 bearer-only-empty", { path: "/api/agent-rooms", method: "GET", headers: { authorization: "Bearer " } }, undefined, 401);
  await t("B6 after=sql", { path: "/api/agent-rooms?after=" + encodeURIComponent("1' OR '1'='1"), method: "GET", headers: { authorization: "Bearer nope" } }, undefined, 401);
  await t("B7 after valid-id garbage", { path: "/api/agent-rooms?after=zzz!!!", method: "GET", headers: { authorization: "Bearer nope" } }, undefined, 401);
  await t("B8 after too long", { path: "/api/agent-rooms?after=" + "a".repeat(200), method: "GET", headers: { authorization: "Bearer nope" } }, undefined, 401);
  await t("B9 after empty", { path: "/api/agent-rooms?after=", method: "GET", headers: { authorization: "Bearer nope" } }, undefined, 401);
  await t("B10 HEAD -> 405", { path: "/api/agent-rooms", method: "HEAD" }, undefined, 405);
  await t("B11 PUT -> 405", { path: "/api/agent-rooms", method: "PUT", headers: { "content-length": "0" } }, undefined, 405);
  await t("B12 DELETE -> 405", { path: "/api/agent-rooms", method: "DELETE", headers: { "content-length": "0" } }, undefined, 405);
  await t("B13 after multi-valued", { path: "/api/agent-rooms?after=a&after=b", method: "GET", headers: { authorization: "Bearer nope" } }, undefined, 401);
  await t("B14 null byte in after", { path: "/api/agent-rooms?after=" + encodeURIComponent("a\0b"), method: "GET", headers: { authorization: "Bearer nope" } }, undefined, 401);
  await t("B15 x-forwarded weird", { path: "/api/agent-rooms", method: "GET", headers: { "x-forwarded-for": "1.2.3.4" } }, undefined, 401);
};

run().then(() => {
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name} => ${r.got} (expect ${r.expect})${r.extra ? " | " + r.extra : ""}`);
  console.log(`\n${results.length - bad.length}/${results.length} as expected, ${bad.length} anomalies`);
  process.exit(0);
});
