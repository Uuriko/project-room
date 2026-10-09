// WAVE-2000 guild-02 worker-13: raw-socket edge probes.
import { connect } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
const HOST = "127.0.0.1", PORT = 49113;
const ORIGIN = "http://127.0.0.1:49113";
const fixtures = readFileSync("worker-13/fixtures.json", "utf8").trim().split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
const F = Object.fromEntries(fixtures.map(f => [f.accountId, f]));
const results = [];

function raw(name, send, { expectStatus, waitMs = 3000, expectClose = false, readAll = true } = {}) {
  return new Promise(resolve => {
    const rec = { name, expect: expectStatus };
    const sock = connect(PORT, HOST);
    let buf = Buffer.alloc(0), done = false;
    const finish = () => { if (done) return; done = true; sock.destroy(); resolve(rec); };
    const timer = setTimeout(() => { rec.timeout = true; rec.status = parseStatus(); rec.pass = false; finish(); }, waitMs);
    const parseStatus = () => { const m = buf.toString("latin1").match(/^HTTP\/\d\.\d (\d{3})/); return m ? Number(m[1]) : null; };
    sock.on("connect", () => sock.write(send));
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      const s = parseStatus();
      if (s !== null && !readAll) { rec.status = s; rec.pass = s === expectStatus; rec.body = buf.toString("latin1").slice(0, 200); clearTimeout(timer); finish(); }
    });
    sock.on("close", () => {
      clearTimeout(timer);
      rec.status = rec.status ?? parseStatus();
      rec.closed = true;
      if (rec.status == null) { rec.pass = expectClose === true; }
      else rec.pass = rec.status === expectStatus;
      rec.body = buf.toString("latin1").slice(0, 200);
      finish();
    });
    sock.on("error", e => { rec.error = e.message; });
  }).then(rec => {
    console.log(`${rec.pass ? "PASS" : "FAIL"} ${rec.status ?? rec.error ?? "timeout"} (exp ${expectStatus}) ${name}${rec.timeout ? " TIMEOUT" : ""}`);
    results.push(rec);
  });
}

const authResend = `Origin: ${ORIGIN}\r\nCookie: account_session=${F["acct-verified"].token}\r\nX-CSRF-Token: ${F["acct-verified"].csrf}\r\n`;

// a. wrong Host header -> 403 host_denied
await raw("wrong-host", `GET /api/account/retention HTTP/1.1\r\nHost: evil.example.com\r\nCookie: account_session=${F["acct-verified"].token}\r\nConnection: close\r\n\r\n`, { expectStatus: 403 });
// b. declared 100MB body, send nothing: handler never reads body -> immediate response, no hang
await raw("declared-100MB-no-body", `POST /api/auth/email/verify/resend HTTP/1.1\r\nHost: 127.0.0.1:49113\r\n${authResend}Content-Length: 100000000\r\nConnection: close\r\n\r\n`, { expectStatus: 422, waitMs: 5000 });
// c. keep-alive reuse after unread body: pipeline POST(unread 5-byte body)+GET health on one connection
await raw("keepalive-unread-body-pipeline",
  `POST /api/auth/email/verify/resend HTTP/1.1\r\nHost: 127.0.0.1:49113\r\n${authResend}Content-Length: 5\r\n\r\nhello` +
  `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:49113\r\nConnection: close\r\n\r\n`,
  { expectStatus: 422, waitMs: 5000 });
// d. malformed request target "//" -> 400 invalid_request (per 2026-10-04 QA note)
await raw("malformed-target", `GET // HTTP/1.1\r\nHost: 127.0.0.1:49113\r\nConnection: close\r\n\r\n`, { expectStatus: 400 });
// e. oversized headers -> 431
await raw("oversized-headers", `GET /api/account/retention HTTP/1.1\r\nHost: 127.0.0.1:49113\r\nX-Pad: ${"A".repeat(20000)}\r\nConnection: close\r\n\r\n`, { expectStatus: 431, waitMs: 5000 });
// f. path traversal encoding
await raw("path-traversal", `GET /api/account/%2e%2e/retention HTTP/1.1\r\nHost: 127.0.0.1:49113\r\nCookie: account_session=${F["acct-verified"].token}\r\nConnection: close\r\n\r\n`, { expectStatus: 404 });
// g. multiple Origin headers -> joined "a, b" -> mismatch -> 403
await raw("multi-origin", `GET /api/account/retention HTTP/1.1\r\nHost: 127.0.0.1:49113\r\nOrigin: ${ORIGIN}\r\nOrigin: https://evil.example.com\r\nCookie: account_session=${F["acct-verified"].token}\r\nConnection: close\r\n\r\n`, { expectStatus: 403 });
// h. chunked body that never ends on resend: handler never reads -> responds anyway
await raw("chunked-never-ending", `POST /api/auth/email/verify/resend HTTP/1.1\r\nHost: 127.0.0.1:49113\r\n${authResend}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n`, { expectStatus: 422, waitMs: 5000 });
// i. NUL byte in path
await raw("nul-in-path", `GET /api/account/retention%00x HTTP/1.1\r\nHost: 127.0.0.1:49113\r\nCookie: account_session=${F["acct-verified"].token}\r\nConnection: close\r\n\r\n`, { expectStatus: 404, waitMs: 5000 });

const fails = results.filter(r => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} raw passed`);
writeFileSync("worker-13/fuzz-raw2-results.json", JSON.stringify(results, null, 1));
// server still alive?
const h = await fetch(`http://${HOST}:${PORT}/api/health`).then(r => r.status).catch(() => "DOWN");
console.log("server health after raw fuzz:", h);
