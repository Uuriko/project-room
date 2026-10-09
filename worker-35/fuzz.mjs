// WORKER 35 fuzz — shard 35/50: GET /api/account/onboarding (server/http.mjs:2368)
// Vectors: auth states, methods, path encodings, headers, raw-socket, concurrency.
// Logs every response; flags crash (conn refused/EPIPE), hang (>8s), unexpected status.
import http from "node:http";
import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:4355";
const cookies = Object.fromEntries(readFileSync("worker-35/.tmp/cookies.txt", "utf8").trim().split("\n").map(l => l.split("=").map((s, i) => i === 0 ? s : l.slice(l.indexOf("=") + 1)).slice(0, 2)));
const AUTHD = { Cookie: cookies.AUTHD };
const ANON = { Cookie: cookies.ANON };
const results = [];
const flag = (name, detail) => results.push({ kind: "FLAG", name, detail });

function raw(path, { method = "GET", headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { req.destroy(new Error("HANG>8s")); }, timeout);
    const req = http.request(BASE + path, { method, headers }, (res) => {
      let n = 0;
      res.on("data", (c) => { n += c.length; });
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, bytes: n }); });
    });
    req.on("error", (e) => { clearTimeout(timer); resolve({ status: `ERROR:${e.code || e.message}` }); });
    if (body) req.write(body);
    req.end();
  });
}

async function expect(name, path, opts, want) {
  const r = await raw(path, opts);
  const ok = want.includes(r.status);
  results.push({ kind: ok ? "ok" : "MISMATCH", name, path, method: opts?.method ?? "GET", got: r.status, want });
  if (!ok) flag(name, `got ${r.status}, want ${want.join("|")}`);
  return r;
}

const ONB = "/api/account/onboarding";

// baseline
await expect("baseline-200-authed", ONB, { headers: AUTHD }, [200]);
await expect("baseline-401-noauth", ONB, {}, [401]);
await expect("baseline-401-anonslot", ONB, { headers: ANON }, [401]);
await expect("baseline-401-garbage", ONB, { headers: { Cookie: "account_session=garbage" } }, [401]);
await expect("baseline-401-other-cookie", ONB, { headers: { Cookie: "room_session=whatever" } }, [401]);

// method matrix
for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE", "PROPFIND"]) {
  await expect(`method-${m}-authed`, ONB, { method: m, headers: AUTHD }, [405]);
}
await expect("method-post-noauth", ONB, { method: "POST" }, [405]);

// path variants (expected: GET /exact path with auth -> 200)
const pathCases = [
  ["trailing-slash", "/api/account/onboarding/", [404]],
  ["double-slash", "//api/account/onboarding", [404]],
  ["query", "/api/account/onboarding?foo=bar", [200]],
  ["query-injection", "/api/account/onboarding?next=http://evil.invalid", [200]],
  ["semicolon-param", "/api/account/onboarding;jsessionid=x", [404]],
  ["dot", "/api/account/onboarding.", [404]],
  ["prefix-suffix", "/api/account/onboardingx", [404]],
  ["sibling-complete", "/api/account/onboarding/complete", [405]],
  ["case", "/api/account/Onboarding", [404]],
  ["pct-slash", "/api/account%2Fonboarding", [404]],
  ["pct-case", "/api/account/%6Fnboarding", [200]],
  ["pct-null", "/api/account/onboarding%00", [404, 400]],
  ["huge-query", "/api/account/onboarding?" + "a".repeat(8000), [200, 414, 400]],
  ["huge-path", "/api/account/" + "o".repeat(3000), [404, 414, 400]],
  ["fragment-style", "/api/account/onboarding#x", [200]],
];
for (const [name, p, want] of pathCases) {
  await expect(`path-${name}`, p, { headers: AUTHD }, want);
}

// header fuzz
await expect("huge-cookie", ONB, { headers: { ...AUTHD, Cookie: cookies.AUTHD + ";" + "x".repeat(12000) } }, [200, 400, 401, 431]);
await expect("malformed-cookie", ONB, { headers: { Cookie: 'account_session="unterminated' } }, [400, 401]);
await expect("huge-header", ONB, { headers: { ...AUTHD, "X-Big": "y".repeat(15000) } }, [200, 400, 431]);
await expect("host-mismatch", ONB, { headers: { ...AUTHD, Host: "evil.invalid" } }, [200, 400, 403]);

// body on GET
await expect("get-with-json-body", ONB, { method: "GET", headers: { ...AUTHD, "Content-Type": "application/json" }, body: JSON.stringify({ admin: true }) }, [200]);
await expect("get-huge-cl-body", ONB, { method: "GET", headers: { ...AUTHD, "Content-Type": "application/json", "Content-Length": "9000000" }, body: "x".repeat(1000) }, [200, 400, 408, 413]);

// concurrency: 60 parallel authed GETs — any hang/error flagged
const conc = await Promise.allSettled(Array.from({ length: 60 }, () => raw(ONB, { headers: AUTHD, timeout: 8000 })));
const concBad = conc.filter((p) => p.status !== "fulfilled" || p.value.status !== 200);
if (concBad.length) flag("concurrency", `${concBad.length}/60 bad: ${JSON.stringify(concBad.slice(0, 5))}`);
results.push({ kind: "ok", name: "concurrency-60", got: `${60 - concBad.length}/60 200s` });

// response shape check
const shape = await fetch(BASE + ONB, { headers: { Cookie: cookies.AUTHD } }).then((r) => r.json());
const shapeOk = typeof shape.accountId === "string" && typeof shape.completed === "boolean" && Array.isArray(shape.steps);
results.push({ kind: shapeOk ? "ok" : "FLAG", name: "authed-body-shape", body: shape });
if (!shapeOk) flag("authed-body-shape", JSON.stringify(shape));

// raw socket: garbage method line + oversized line
async function rawSocket(payload, name) {
  await new Promise((resolve) => {
    const s = net.connect(4355, "127.0.0.1");
    let data = "";
    s.setTimeout(5000, () => { flag(name, "HANG>5s"); s.destroy(); resolve(); });
    s.on("error", (e) => { results.push({ kind: "ok", name, got: `socket-error:${e.code}` }); resolve(); });
    s.on("data", (c) => { data += c.toString("latin1"); });
    s.on("close", () => { const line = data.split("\r\n")[0]; results.push({ kind: "ok", name, got: line || "closed-no-data" }); resolve(); });
    s.write(payload);
  });
}
await rawSocket("GARBAGE /api/account/onboarding HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "raw-garbage-method");
await rawSocket("GET /api/account/onboarding?" + "q".repeat(20000) + " HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "raw-oversized-line");
await rawSocket("GET /api/account/onboarding HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: account_session=" + "z".repeat(50000) + "\r\n\r\n", "raw-huge-cookie");

// server still alive?
const health = await raw("/api/health");
results.push({ kind: health.status === 200 ? "ok" : "FLAG", name: "server-alive-end", got: health.status });
if (health.status !== 200) flag("server-alive-end", `health=${health.status}`);

const flags = results.filter((r) => r.kind === "FLAG" || r.kind === "MISMATCH");
console.log(JSON.stringify({ total: results.length, flagCount: flags.length }, null, 1));
for (const f of flags) console.log("FLAG:", JSON.stringify(f));
writeFileSync("worker-35/fuzz-results.json", JSON.stringify(results, null, 1));
