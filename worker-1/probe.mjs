// Follow-up probes to characterize the two ECONNRESET anomalies from fuzz.mjs.
import { request } from "node:http";
const HOST = "127.0.0.1", PORT = Number(process.env.FUZZ_PORT || 44217);
const SECRET = process.env.W1_SECRET || "";
function call({ method = "GET", path, headers = {}, body = null, timeout = 8000 }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { req.destroy(); resolve({ timeout: true }); }, timeout);
    const req = request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode }); });
    });
    req.on("error", (e) => { clearTimeout(timer); resolve({ error: e.code || e.message }); });
    if (body) req.write(body);
    req.end();
  });
}
const auth = { Authorization: `Bearer ${SECRET}` };
const out = [];
// 1. kinds length sweep (query-string length vs Node maxHeaderSize)
for (const n of [100, 1000, 8000, 15000, 16384, 20000, 100000]) {
  const r = await call({ path: `/api/updates?kinds=${"x".repeat(n)}`, headers: auth });
  out.push(`kinds_len=${n} -> ${r.timeout ? "TIMEOUT" : (r.error ? "ERR:" + r.error : r.status)}`);
}
// 2. GET with body sweep on /api/updates (authed) and security.txt
for (const n of [0, 10, 1000, 500000]) {
  const headers = { ...auth, "Content-Type": "application/json" };
  const r = await call({ path: "/api/updates", headers, body: n ? JSON.stringify({ x: "y".repeat(n) }) : null });
  out.push(`updates GET body_bytes=${n} -> ${r.timeout ? "TIMEOUT" : (r.error ? "ERR:" + r.error : r.status)}`);
}
for (const n of [0, 100]) {
  const r = await call({ path: "/.well-known/security.txt", headers: { "Content-Type": "application/json" }, body: n ? "{}" : null });
  out.push(`security GET body_bytes=${n} -> ${r.timeout ? "TIMEOUT" : (r.error ? "ERR:" + r.error : r.status)}`);
}
console.log(out.join("\n"));
