// WAVE-2000 G02 WORKER 31 — round 3: /agents + POST /api/agent-invites/redeem
import http from "node:http";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:18033";
const OUT = [];
function req(method, path, { headers = {}, body = null, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request(BASE + path, { method, headers, timeout }, (res) => {
      let n = 0; const chunks = [];
      res.on("data", (c) => { n += c.length; if (chunks.length < 4) chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0, bytes: n,
        ctype: res.headers["content-type"] || "", allow: res.headers.allow || "",
        head: Buffer.concat(chunks).toString("utf8", 0, 400) }));
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: "TIMEOUT", ms: Date.now() - t0 }); });
    r.on("error", (e) => resolve({ status: "ERR:" + e.code, ms: Date.now() - t0, head: e.message.slice(0, 200) }));
    if (body !== null) r.write(body);
    r.end();
  });
}
const J = (o) => JSON.stringify(o);

async function main() {
  const A = "agents";
  let r = await req("GET", "/agents"); OUT.push({ n: A, m: "GET", p: "/agents", s: r.status, ms: r.ms, x: r.ctype });
  r = await req("HEAD", "/agents"); OUT.push({ n: A, m: "HEAD", p: "/agents", s: r.status, ms: r.ms });
  for (const m of ["POST", "PUT", "DELETE"]) { r = await req(m, "/agents"); OUT.push({ n: A, m, p: "/agents", s: r.status, ms: r.ms, x: r.allow }); }
  r = await req("GET", "/agents/"); OUT.push({ n: A, m: "GET", p: "/agents/", s: r.status, ms: r.ms });
  r = await req("GET", "/AGENTS"); OUT.push({ n: A, m: "GET", p: "/AGENTS", s: r.status, ms: r.ms });
  r = await req("GET", "/agents?cursor=" + "z".repeat(3000)); OUT.push({ n: A, m: "GET", p: "/agents?cursor=3k", s: r.status, ms: r.ms });
  r = await req("GET", "/agents?ref=" + encodeURIComponent("\"><script>alert(1)</script>"));
  OUT.push({ n: A, m: "GET", p: "/agents?ref=xss", s: r.status, ms: r.ms,
    x: r.head.includes('"><script>alert(1)</script>') ? "REFLECTED-UNESCAPED" : "not-reflected/raw" });

  const R = "redeem", P = "/api/agent-invites/redeem";
  const post = (b, h = {}) => req("POST", P, { headers: { "content-type": "application/json", ...h },
    body: typeof b === "string" ? b : J(b) });
  const cases = [
    ["valid-shape-bogus", { code: "nope-not-real", displayName: "fuzz" }],
    ["code-empty", { code: "", displayName: "fuzz" }],
    ["code-5k", { code: "c".repeat(5000), displayName: "fuzz" }],
    ["code-traversal", { code: "../../etc", displayName: "fuzz" }],
    ["code-num", { code: 42, displayName: "fuzz" }],
    ["code-null", { code: null, displayName: "fuzz" }],
    ["name-5k", { code: "x", displayName: "n".repeat(5000) }],
    ["name-empty", { code: "x", displayName: "" }],
    ["name-num", { code: "x", displayName: 7 }],
    ["missing-code", { displayName: "fuzz" }],
    ["missing-name", { code: "x" }],
    ["empty-obj", {}],
    ["extra-key", { code: "x", displayName: "f", admin: true }],
    ["arr-body", [1]],
    ["malformed", "{oops"],
    ["empty-body", ""],
    ["wrong-ctype", J({ code: "x", displayName: "f" })],
  ];
  for (const [nm, b] of cases.slice(0, 16)) {
    r = await post(b);
    OUT.push({ n: R, m: "POST", p: nm, s: r.status, ms: r.ms, x: r.head.slice(0, 200) });
  }
  r = await req("POST", P, { headers: { "content-type": "text/plain" }, body: cases[16][1] });
  OUT.push({ n: R, m: "POST", p: "wrong-ctype", s: r.status, ms: r.ms, x: r.head.slice(0, 160) });
  for (const m of ["GET", "PUT", "DELETE", "HEAD"]) {
    r = await req(m, P); OUT.push({ n: R, m, p: P, s: r.status, ms: r.ms, x: "allow=" + r.allow });
  }
  writeFileSync(new URL("./fuzz-31b-results.json", import.meta.url), JSON.stringify(OUT, null, 1));
  for (const o of OUT) console.log(o.n, o.m, o.p, "->", o.s, `(${o.ms}ms)`, o.x || "");
  const bad = OUT.filter((o) => o.s === 500 || String(o.s).startsWith("ERR") || o.s === "TIMEOUT" || String(o.x || "").includes("REFLECTED-UNESCAPED"));
  console.log("ANOMALIES:", bad.length, JSON.stringify(bad));
}
main();
