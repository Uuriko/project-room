#!/usr/bin/env node
// worker-33 fuzz harness — shard 33/50: (a) GET /join.html + /room/join.html redirect, (b) POST /api/web/research
import { request } from "node:http";

const BASE = "http://127.0.0.1:43331";
const results = [];

function send({ method = "GET", path = "/", headers = {}, body = null, timeout = 8000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = request(BASE + path, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8", 0, 2000), ms: Date.now() - t0 }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error("TIMEOUT")); });
    req.on("error", (e) => resolve({ ok: false, error: e.message, ms: Date.now() - t0 }));
    if (body != null) req.write(body);
    req.end();
  });
}

async function case_(name, opts, expect) {
  const r = await send(opts);
  const pass = typeof expect === "function" ? expect(r) : true;
  results.push({ name, opts: { method: opts.method ?? "GET", path: opts.path }, got: r, pass, note: expect?.note });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} -> ${r.ok ? r.status : "ERR:" + r.error} (${r.ms}ms)`);
}

// ---------- (a) /join.html redirects ----------
await case_("join.html GET -> 301 /join?search", { path: "/join.html" }, r => r.status === 301 && r.headers.location === "/join");
await case_("room join.html GET -> 301 /room/join", { path: "/room/join.html" }, r => r.status === 301 && r.headers.location === "/room/join");
await case_("join.html with query preserved", { path: "/join.html?room=abc" }, r => r.status === 301 && r.headers.location === "/join?room=abc");
await case_("join.html HEAD -> 301 no body", { method: "HEAD", path: "/join.html" }, r => r.status === 301 && r.body.length === 0);
await case_("join.html POST (non-GET) -> ???", { method: "POST", path: "/join.html" }, r => r.status === 404);
await case_("join.html PUT (non-GET) -> ???", { method: "PUT", path: "/join.html" }, r => r.status === 404);
await case_("join.html DELETE (non-GET) -> ???", { method: "DELETE", path: "/join.html" }, r => r.status === 404);
await case_("join.html OPTIONS -> ???", { method: "OPTIONS", path: "/join.html" }, r => r.status === 404);
await case_("join.html trailing slash -> 301 (deliberate QA 2026-10-03 normalization)", { path: "/join.html/" }, r => r.status === 301 && r.headers.location === "/join");
await case_("join.html uppercase -> 404?", { path: "/JOIN.HTML" }, r => r.status === 404);
await case_("join.html encoded -> ???", { path: "/join%2ehtml" }, r => r.status === 404);
await case_("join.htm typo -> 404?", { path: "/join.htm" }, r => r.status === 404);
await case_("favicon.ico redirect", { path: "/favicon.ico" }, r => r.status === 301 && r.headers.location === "/favicon.svg");
await case_("room favicon.ico redirect", { path: "/room/favicon.ico" }, r => r.status === 301 && r.headers.location === "/room/favicon.svg");
await case_("double html suffix -> 404 (correct, exact-match only)", { path: "/join.html.html" }, r => r.status === 404);
await case_("join.html with huge query (16k) -> client parser limit (node http, not server)", { path: "/join.html?" + "x".repeat(16000) }, r => !r.ok && /Parse Error/.test(r.error));

// ---------- (b) /api/web/research ----------
await case_("research GET -> 405", { path: "/api/web/research" }, r => r.status === 405);
await case_("research HEAD -> 405", { method: "HEAD", path: "/api/web/research" }, r => r.status === 405);
await case_("research PUT -> 405", { method: "PUT", path: "/api/web/research" }, r => r.status === 405);
await case_("research DELETE -> 405", { method: "DELETE", path: "/api/web/research" }, r => r.status === 405);
await case_("research OPTIONS -> ???", { method: "OPTIONS", path: "/api/web/research" }, r => r.status === 405);
await case_("research POST no auth -> 401", { method: "POST", path: "/api/web/research", headers: { "content-type": "application/json" }, body: "{}" }, r => r.status === 401);
await case_("research POST junk bearer -> 401", { method: "POST", path: "/api/web/research", headers: { authorization: "Bearer junk", "content-type": "application/json" }, body: "{}" }, r => r.status === 401);
await case_("research POST empty body no auth -> 401", { method: "POST", path: "/api/web/research" }, r => r.status === 401);
await case_("research POST invalid JSON no auth -> 401 (before parse)", { method: "POST", path: "/api/web/research", headers: { "content-type": "application/json" }, body: "{not json" }, r => r.status === 401);
await case_("research POST huge body no auth -> 401 not 413?", { method: "POST", path: "/api/web/research", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "x".repeat(3 * 1024 * 1024) }) }, r => [401, 413].includes(r.status));
await case_("research POST garbage content-type no auth -> 401", { method: "POST", path: "/api/web/research", headers: { "content-type": "text/html" }, body: "<html>" }, r => r.status === 401);
await case_("research trailing slash -> 401 (normalization routes it to the handler)", { method: "POST", path: "/api/web/research/", headers: { "content-type": "application/json" }, body: "{}" }, r => r.status === 401);
await case_("research uppercase path -> 404?", { method: "POST", path: "/api/WEB/RESEARCH", headers: { "content-type": "application/json" }, body: "{}" }, r => r.status === 404);
await case_("research POST query-string auth -> ???", { method: "POST", path: "/api/web/research?auth=room", headers: { "content-type": "application/json" }, body: "{}" }, r => r.status === 401);

const fails = results.filter(r => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log(` - ${f.name}: ${f.opts.method} ${f.opts.path} -> ${JSON.stringify(f.got)}`); }
import { writeFileSync } from "node:fs";
writeFileSync(new URL("results.json", import.meta.url), JSON.stringify(results, null, 2));
process.exit(fails.length ? 1 : 0);
