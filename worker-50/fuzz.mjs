// WAVE-2000 GUILD-02 worker-50 fuzz harness.
// Shard: block idx 49 (0-based) of `if (url.pathname ...)` dispatch blocks in
// server/http.mjs => GET/HEAD /api/guest-agent-links (guestAgentLinkContract).
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import net from "node:net";

const f = await createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const results = [];
function rec(tname, kase, method, path, status, ms, head, verdict) {
  results.push({ tname, case: kase, method, path, status, ms, head: (head || "").slice(0, 160), verdict });
  if (verdict !== "ok") console.log(`ANOMALY ${kase}: ${method} ${path} -> ${status} (${verdict})`);
}

async function rawRequest(raw, timeoutMs = 6000) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    const t0 = Date.now();
    let data = "";
    let done = false;
    const finish = (status, head) => {
      if (done) return; done = true;
      clearTimeout(timer); sock.destroy();
      resolve({ status, ms: Date.now() - t0, head: data.split("\r\n\r\n")[0] });
    };
    const timer = setTimeout(() => finish("TIMEOUT", data), timeoutMs);
    sock.on("connect", () => sock.write(raw));
    sock.on("data", c => { data += c.toString("latin1"); });
    sock.on("end", () => {
      const m = data.match(/^HTTP\/\d\.\d (\d{3})/);
      finish(m ? Number(m[1]) : "SOCKET-EOF", data);
    });
    sock.on("error", e => finish("SOCKET-ERROR", e.message));
    sock.on("close", () => { if (!done) { const m = data.match(/^HTTP\/\d\.\d (\d{3})/); finish(m ? Number(m[1]) : "SOCKET-CLOSED", data); } });
  });
}

async function fetchCase(kase, method, path, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, { method, ...opts });
    const txt = method === "HEAD" ? "" : (await r.text()).slice(0, 160);
    return { status: r.status, ms: Date.now() - t0, head: txt, headers: Object.fromEntries(r.headers.entries()) };
  } catch (e) {
    return { status: "FETCH-ERROR", ms: Date.now() - t0, head: e.message, headers: {} };
  }
}

const P = "/api/guest-agent-links";

// --- fetch-based cases ---
const fetchCases = [
  ["get", "GET", P],
  ["head", "HEAD", P],
  ["get-query", "GET", P + "?a=1&b=%20&x=" + "y".repeat(100)],
  ["get-8k-query", "GET", P + "?" + "k=".repeat(1) + "v".repeat(7000)],
  ["get-trailing-slash", "GET", P + "/"],
  ["get-upper", "GET", "/API/GUEST-AGENT-LINKS"],
  ["get-double-slash", "GET", "/api//guest-agent-links"],
  ["get-encoded-g", "GET", "/api/%67uest-agent-links"],
  ["get-semicolon", "GET", P + ";jsessionid=abc"],
  ["get-dotseg", "GET", "/api/x/../guest-agent-links"],
  ["get-long-path", "GET", "/api/" + "z".repeat(4000)],
  ["put", "PUT", P],
  ["delete", "DELETE", P],
  ["patch", "PATCH", P],
  ["options", "OPTIONS", P],
  ["propfIND", "PROPFIND", P],
  ["connect", "CONNECT", P],
];

for (const [kase, method, path] of fetchCases) {
  const r = await fetchCase(kase, method, path);
  let verdict = "ok";
  if (kase === "get") {
    try {
      const j = JSON.parse(r.head.startsWith("{") ? await (await fetch(base + path)).text() : "{}");
      if (r.status !== 200 || j.kind !== "guest-agent" && j.kind !== undefined) { /* check below */ }
    } catch {}
    const rr = await fetch(base + path); const jj = await rr.json().catch(() => null);
    if (r.status !== 200 || !jj || jj.mint !== "owner_issued") verdict = "wrong-status-or-body";
  }
  if (kase === "head") {
    const cl = Number(r.headers["content-length"] || 0);
    if (r.status !== 200) verdict = "wrong-status";
    else if (cl <= 0) verdict = "head-missing-content-length";
  }
  if (["put","delete","patch","options","propfIND","connect"].includes(kase) && typeof r.status === "number" && ![404,405].includes(r.status)) verdict = "wrong-status";
  if (r.status === "FETCH-ERROR" || r.status === "TIMEOUT") verdict = "transport-anomaly";
  rec("w50-fetch", kase, method, path, r.status, r.ms, r.head, verdict);
}

// --- raw socket cases (methods / shapes fetch cannot express) ---
const rawCases = [
  ["raw-trace", "TRACE /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"],
  ["raw-trace-maxforwards", "TRACE /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nMax-Forwards: 1\r\nConnection: close\r\n\r\n"],
  ["raw-get-with-body", "GET /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"],
  ["raw-get-chunked", "GET /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n"],
  ["raw-get-nullbyte", "GET /api/guest-agent-links%00x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"],
  ["raw-get-no-host", "GET /api/guest-agent-links HTTP/1.1\r\nConnection: close\r\n\r\n"],
  ["raw-head-huge-path", "HEAD /api/" + "q".repeat(8000) + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"],
  ["raw-get-http10", "GET /api/guest-agent-links HTTP/1.0\r\n\r\n"],
  ["raw-lowercase-method", "get /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"],
  ["raw-space-in-path", "GET /api/guest agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"],
  ["raw-absolute-uri", "GET http://127.0.0.1:" + port + "/api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"],
  ["raw-dup-content-length", "GET /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhello!"],
  ["raw-slow-headers", null], // partial headers, never terminated
];

for (const [kase, raw] of rawCases) {
  if (raw === null) {
    const r = await new Promise(resolve => {
      const sock = net.connect(port, "127.0.0.1");
      const t0 = Date.now(); let data = "";
      sock.on("connect", () => sock.write("GET /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nX-A: 1\r\n"));
      const timer = setTimeout(() => { sock.destroy(); resolve({ status: "TIMEOUT", ms: Date.now() - t0, head: data }); }, 6000);
      sock.on("data", c => { data += c.toString("latin1"); });
      sock.on("close", () => { clearTimeout(timer); resolve({ status: "SOCKET-CLOSED", ms: Date.now() - t0, head: data }); });
    });
    rec("w50-raw", kase, "RAW", "", r.status, r.ms, r.head, r.status === "TIMEOUT" ? "hang-unterminated-headers" : "ok");
    continue;
  }
  const r = await rawRequest(raw);
  let verdict = "ok";
  if (r.status === "TIMEOUT") verdict = "hang";
  else if (kase.startsWith("raw-trace") && typeof r.status === "number" && ![404,405].includes(r.status)) verdict = "wrong-status";
  else if (kase === "raw-get-with-body" && r.status !== 200) verdict = "wrong-status";
  else if (kase === "raw-get-chunked" && r.status !== 200 && r.status !== 400) verdict = "wrong-status";
  rec("w50-raw", kase, "RAW", "", r.status, r.ms, r.head, verdict);
}

server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
f.store.close();

const anomalies = results.filter(r => r.verdict !== "ok");
console.log(JSON.stringify({ total: results.length, anomalies: anomalies.length }, null, 1));
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./fuzz-results.json", import.meta.url), JSON.stringify({ route: "GET/HEAD /api/guest-agent-links", shard: 49, results }, null, 1));
console.log("wrote fuzz-results.json");
