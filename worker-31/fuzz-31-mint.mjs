// WAVE-2000 G02 WORKER 31 — round 2: POST /api/referral-invites/mint with a
// well-formed (43-char) but unknown identity secret, to reach store validation.
import http from "node:http";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:18032";
const P = "/api/referral-invites/mint";
const GOOD = "Bearer " + "a".repeat(43); // passes bearer() shape check, unknown identity
const OUT = [];

function req(method, path, { headers = {}, body = null, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request(BASE + path, { method, headers, timeout }, (res) => {
      let n = 0; const chunks = [];
      res.on("data", (c) => { n += c.length; if (chunks.length < 4) chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0, bytes: n,
        head: Buffer.concat(chunks).toString("utf8", 0, 500) }));
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: "TIMEOUT", ms: Date.now() - t0 }); });
    r.on("error", (e) => resolve({ status: "ERR:" + e.code, ms: Date.now() - t0, head: e.message.slice(0, 200) }));
    if (body !== null) r.write(body);
    r.end();
  });
}
const post = (b, h = {}) => req("POST", P, { headers: { authorization: GOOD, "content-type": "application/json", ...h },
  body: typeof b === "string" ? b : JSON.stringify(b) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // stay under the 20/min limiter: 12 requests, then pause, then 8
  const cases = [
    ["ok-min", { roomId: "room_x" }],
    ["ok-cap", { roomId: "room_x", maxDepth: 3 }],
    ["missing-roomId", {}],
    ["roomId-num", { roomId: 123 }],
    ["roomId-null", { roomId: null }],
    ["extra-key", { roomId: "x", bogus: 1 }],
    ["maxDepth-str", { roomId: "x", maxDepth: "deep" }],
    ["maxDepth-neg", { roomId: "x", maxDepth: -5 }],
    ["maxDepth-float", { roomId: "x", maxDepth: 1.5 }],
    ["maxDepth-huge", { roomId: "x", maxDepth: 1e308 }],
    ["maxDepth-bool", { roomId: "x", maxDepth: true }],
    ["maxDepth-null", { roomId: "x", maxDepth: null }],
  ];
  for (const [nm, b] of cases) {
    const r = await post(b);
    OUT.push({ nm, status: r.status, ms: r.ms, head: r.head.slice(0, 300) });
    console.log(nm, "->", r.status, `(${r.ms}ms)`, r.head.slice(0, 160));
  }
  console.log("--- waiting 65s for rate window ---");
  await sleep(65000);
  const cases2 = [
    ["roomId-5k", { roomId: "r".repeat(5000) }],
    ["roomId-traversal", { roomId: "../../etc/passwd" }],
    ["roomId-empty", { roomId: "" }],
    ["roomId-unicode", { roomId: "röö🤖m" }],
    ["arr-body", [1, 2]],
    ["null-body", null],
    ["malformed-json", "{not json"],
    ["empty-body", ""],
  ];
  for (const [nm, b] of cases2) {
    const r = await post(b);
    OUT.push({ nm, status: r.status, ms: r.ms, head: r.head.slice(0, 300) });
    console.log(nm, "->", r.status, `(${r.ms}ms)`, r.head.slice(0, 160));
  }
  writeFileSync(new URL("./fuzz-31-mint-results.json", import.meta.url), JSON.stringify(OUT, null, 1));
  const bad = OUT.filter((o) => o.status === 500 || String(o.status).startsWith("ERR") || o.status === "TIMEOUT");
  console.log("ANOMALIES:", bad.length, JSON.stringify(bad));
}
main();
