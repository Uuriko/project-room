#!/usr/bin/env node
// worker-33: research EXECUTION path (planOnly falsy) — legs run for real but only
// against loopback-blocked / invalid URLs (no external calls) and empty local corpus.
import { request } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:43331";
const cred = JSON.parse(readFileSync("worker-33/.tmp/cred.json", "utf8"));
const token = cred.cookie.split("=")[1];
const CJ = { "content-type": "application/json", authorization: "Bearer " + token };
const results = [];
function send({ body, timeout = 20000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = request(BASE + "/api/web/research", { method: "POST", headers: CJ }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks).toString("utf8", 0, 3000), ms: Date.now() - t0 }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error("TIMEOUT")));
    req.on("error", (e) => resolve({ ok: false, error: e.message, ms: Date.now() - t0 }));
    req.write(body); req.end();
  });
}
async function case_(name, payload, check) {
  let r = await send({ body: JSON.stringify(payload) });
  for (let i = 0; i < 4 && !r.ok; i++) { await new Promise(r2 => setTimeout(r2, 1500)); r = await send({ body: JSON.stringify(payload) }); }
  let detail = "";
  try { detail = JSON.stringify(JSON.parse(r.body || "{}"), (k, v) => k === "request_id" ? undefined : v).slice(0, 500); } catch {}
  const pass = check(r, detail);
  results.push({ name, got: r.ok ? r.status : "ERR:" + r.error, pass, detail: detail.slice(0, 300) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} -> ${r.ok ? r.status : "ERR:" + r.error} (${r.ms}ms) ${detail.slice(0, 220)}`);
}
const is200 = (r) => r.ok && r.status === 200;
// loopback SSRF must be refused as a fetch error, never fetched, never 500
await case_("fetch loopback url blocked", { question: "q?", sources: ["fetch"], urls: ["http://127.0.0.1:43331/api/health"] }, (r, d) => is200(r) && /fetch_errors/.test(d));
await case_("fetch closed port -> fetch_errors", { question: "q?", sources: ["fetch"], urls: ["http://127.0.0.1:9/x"] }, (r, d) => is200(r) && /fetch_errors/.test(d));
await case_("fetch metadata IP blocked", { question: "q?", sources: ["fetch"], urls: ["http://169.254.169.254/latest/meta-data/"] }, (r, d) => is200(r) && /fetch_errors/.test(d));
await case_("fetch garbage url", { question: "q?", sources: ["fetch"], urls: ["not a url"] }, (r, d) => is200(r) && /fetch_errors/.test(d));
await case_("fetch no urls given -> ?", { question: "q?", sources: ["fetch"] }, (r) => is200(r));
await case_("provider leg unconfigured", { question: "q?", sources: ["provider"] }, (r, d) => is200(r));
await case_("all sources exec", { question: "q?", sources: ["room", "docs", "fetch", "provider"], urls: ["http://127.0.0.1:9/x"], maxEvidence: 2 }, (r, d) => is200(r) && r.ms < 15000);
// quota: repeated execs should not 500 (daily quota is high; just ensure no crash)
for (let i = 0; i < 3; i++) {
  await case_(`exec repeat ${i + 1} room+docs`, { question: `repeat ${i}`, sources: ["room", "docs"] }, (r) => is200(r) || (r.ok && r.status === 429));
}
const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
writeFileSync("worker-33/results-exec.json", JSON.stringify(results, null, 2));
process.exit(fails.length ? 1 : 0);
