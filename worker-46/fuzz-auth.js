// WAVE-2000 G02 worker-46: authenticated-path fuzz for shard routes.
//   A: GET /api/auth/methods with a real account_session cookie (line 2248)
//   B: GET /api/agent-rooms with a real pri_ identity secret (line 3112)
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.W46_PORT || 4281);
const TIMEOUT_MS = 8000;

// Ephemeral test credentials minted against the throwaway local DB only.
// Never reused anywhere else; rotated by re-running mint-session.mjs.
import fs from "node:fs";
const readCred = (env, file) => process.env[env] || fs.readFileSync(new URL(file, import.meta.url), "utf8").trim();
const SESSION_COOKIE = readCred("W46_SESSION_COOKIE", ".creds-session.txt");
const PRI_SECRET = readCred("W46_PRI_SECRET", ".creds-pri.txt");
if (!SESSION_COOKIE || !PRI_SECRET) { console.error("need creds files or env"); process.exit(2); }

function raw(opts, body) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { resolve({ hang: true }); req.destroy(); }, TIMEOUT_MS);
    const req = http.request({ host: HOST, port: PORT, ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(t);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8", 0, 3000) });
      });
    });
    req.on("error", (e) => { clearTimeout(t); resolve({ error: e.message }); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const results = [];
async function t(name, opts, body, expect, show) {
  const r = await raw(opts, body);
  const got = r.hang ? "HANG" : (r.error ? `ERR:${r.error}` : r.status);
  const ok = expect === "any" || got === expect;
  const safeBody = r.body || "";
  results.push({ name, got, expect, ok, detail: show ? safeBody.slice(0, 400) : (r.status >= 500 ? safeBody.slice(0, 400) : undefined) });
}

const acctCookie = `account_session=${SESSION_COOKIE}`;
const tampered = SESSION_COOKIE.slice(0, -1) + (SESSION_COOKIE.slice(-1) === "a" ? "b" : "a");
const bearer = `Bearer ${PRI_SECRET}`;

const run = async () => {
  // ---------- Route A: /api/auth/methods, authenticated ----------
  await t("AA1 valid session GET", { path: "/api/auth/methods", method: "GET", headers: { cookie: acctCookie } }, undefined, 200, true);
  await t("AA2 valid session + query junk", { path: "/api/auth/methods?x=1&after=2", method: "GET", headers: { cookie: acctCookie } }, undefined, 200);
  await t("AA3 valid session POST -> 405", { path: "/api/auth/methods", method: "POST", headers: { cookie: acctCookie, "content-length": "0" } }, undefined, 405);
  await t("AA4 valid session HEAD -> 405", { path: "/api/auth/methods", method: "HEAD", headers: { cookie: acctCookie } }, undefined, 405);
  await t("AA5 tampered token", { path: "/api/auth/methods", method: "GET", headers: { cookie: `account_session=${tampered}` } }, undefined, 401);
  await t("AA6 truncated token", { path: "/api/auth/methods", method: "GET", headers: { cookie: `account_session=${SESSION_COOKIE.slice(0, 20)}` } }, undefined, 401);
  await t("AA7 weird method lowercase get", { path: "/api/auth/methods", method: "get", headers: { cookie: acctCookie } }, undefined, "any");
  await t("AA8 accept garbage", { path: "/api/auth/methods", method: "GET", headers: { cookie: acctCookie, accept: "x/".repeat(2000) } }, undefined, 200);
  await t("AA9 origin header", { path: "/api/auth/methods", method: "GET", headers: { cookie: acctCookie, origin: "http://evil.example" } }, undefined, 200);
  await t("AA10 huge cookie prefix", { path: "/api/auth/methods", method: "GET", headers: { cookie: `junk=${"z".repeat(3000)}; account_session=${SESSION_COOKIE}` } }, undefined, 200);

  // ---------- Route B: /api/agent-rooms, authenticated ----------
  await t("BB1 valid secret, no after", { path: "/api/agent-rooms", method: "GET", headers: { authorization: bearer } }, undefined, 200, true);
  await t("BB2 after empty", { path: "/api/agent-rooms?after=", method: "GET", headers: { authorization: bearer } }, undefined, 200);
  await t("BB3 after valid-ish id", { path: "/api/agent-rooms?after=room-abc123", method: "GET", headers: { authorization: bearer } }, undefined, 200);
  await t("BB4 after with bad chars", { path: "/api/agent-rooms?after=" + encodeURIComponent("a!b$c"), method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB5 after sql", { path: "/api/agent-rooms?after=" + encodeURIComponent("1' OR '1'='1"), method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB6 after 129 chars", { path: "/api/agent-rooms?after=" + "a".repeat(129), method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB7 after exactly 128 chars", { path: "/api/agent-rooms?after=" + "a".repeat(128), method: "GET", headers: { authorization: bearer } }, undefined, 200);
  await t("BB8 after unicode", { path: "/api/agent-rooms?after=" + encodeURIComponent("caf\u00e9"), method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB9 after null byte", { path: "/api/agent-rooms?after=" + encodeURIComponent("a\0b"), method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB10 after=__proto__", { path: "/api/agent-rooms?after=__proto__", method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB11 after=constructor", { path: "/api/agent-rooms?after=constructor", method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB12 after dot-dot", { path: "/api/agent-rooms?after=" + encodeURIComponent(".."), method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB13 after multi-valued", { path: "/api/agent-rooms?after=a&after=b", method: "GET", headers: { authorization: bearer } }, undefined, 200);
  await t("BB14 after + extra unknown param", { path: "/api/agent-rooms?after=&evil=1", method: "GET", headers: { authorization: bearer } }, undefined, 200);
  await t("BB15 after with colon/dots (validId allows)", { path: "/api/agent-rooms?after=" + encodeURIComponent("a:b.c-d_e"), method: "GET", headers: { authorization: bearer } }, undefined, 200);
  await t("BB16 spaces in after", { path: "/api/agent-rooms?after=" + encodeURIComponent("a b"), method: "GET", headers: { authorization: bearer } }, undefined, 422);
  await t("BB17 percent-encoded invalid", { path: "/api/agent-rooms?after=%ZZ", method: "GET", headers: { authorization: bearer } }, undefined, "any");
  await t("BB18 secret tampered", { path: "/api/agent-rooms", method: "GET", headers: { authorization: `Bearer ${PRI_SECRET.slice(0, -1)}x` } }, undefined, 401);
  await t("BB19 secret double", { path: "/api/agent-rooms", method: "GET", headers: { authorization: `${bearer}, ${bearer}` } }, undefined, "any");
  await t("BB20 after=0", { path: "/api/agent-rooms?after=0", method: "GET", headers: { authorization: bearer } }, undefined, 200);
};

run().then(() => {
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name} => ${r.got} (expect ${r.expect})${r.detail ? " | " + r.detail : ""}`);
  console.log(`\n${results.length - bad.length}/${results.length} as expected, ${bad.length} anomalies`);
  process.exit(0);
});
