// WAVE-2000 GUILD-02 WORKER 23 — extended fuzz battery for shard handler
// server/http.mjs:2808  if (url.pathname === "/api/web/fetch") { ... }
// Boots with NODE_ENV=test + WEB_FETCH_ALLOW_LOOPBACK=1 so the test-context
// loopback allowance opens 127.0.0.1 targets; a local adversarial origin
// exercises the full fetch pipeline (redirects, timeouts, body cap, decode).
// Usage: TMPDIR=$PWD/.tmp NODE_ENV=test WEB_FETCH_ALLOW_LOOPBACK=1 node worker-23/fuzz-webfetch.mjs
import http from "node:http";
import zlib from "node:zlib";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { writeFileSync } from "node:fs";

// ---- adversarial origin -------------------------------------------------
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const port = origin.address().port;
  switch (u.pathname) {
    case "/ok":
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html><body>hello world</body></html>");
    case "/slow-headers":
      setTimeout(() => { try { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<p>late</p>"); } catch {} }, 20000);
      return;
    case "/drip":
      res.writeHead(200, { "Content-Type": "text/html" });
      { let n = 0; const t = setInterval(() => { try { res.write("x"); } catch { clearInterval(t); } if (++n >= 60) { clearInterval(t); try { res.end(); } catch {} } }, 400); }
      return;
    case "/big":
      res.writeHead(200, { "Content-Type": "text/html" });
      { const chunk = "a".repeat(65536); for (let i = 0; i < 48; i++) res.write(chunk); res.end(); }
      return;
    case "/redir-loop":
      res.writeHead(302, { Location: "/redir-loop" }); return res.end();
    case "/redir-private":
      res.writeHead(302, { Location: "http://10.0.0.1/" }); return res.end();
    case "/redir-file":
      res.writeHead(302, { Location: "file:///etc/passwd" }); return res.end();
    case "/redir-ok":
      res.writeHead(302, { Location: "/ok" }); return res.end();
    case "/redir-chain": {
      const n = Number(u.searchParams.get("n") ?? "0");
      res.writeHead(302, { Location: `/redir-chain?n=${n + 1}` }); return res.end();
    }
    case "/notfound":
      res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<p>nope</p>");
    case "/servererror":
      res.writeHead(500, { "Content-Type": "text/html" }); return res.end("<p>oops</p>");
    case "/nothtml":
      res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("just plain text");
    case "/noct-html":
      res.writeHead(200); return res.end("<p>sniff me</p>");
    case "/gzip":
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      return res.end(zlib.gzipSync("<html><body>gzipped</body></html>"));
    case "/gzip-bomb":
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      return res.end(zlib.gzipSync("z".repeat(30 * 1024 * 1024)));
    case "/charset-bogus":
      res.writeHead(200, { "Content-Type": "text/html; charset=bogus-charset-xyz" });
      return res.end("<p>charset test</p>");
    case "/charset-utf16":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-16" });
      return res.end(Buffer.from("<p>utf16</p>", "utf16le"));
    case "/empty-200":
      res.writeHead(200, { "Content-Type": "text/html" }); return res.end("");
    default:
      res.writeHead(404); return res.end();
  }
});
await new Promise(r => origin.listen(0, "127.0.0.1", r));
const OP = `http://127.0.0.1:${origin.address().port}`;

// ---- room server ---------------------------------------------------------
const fixture = await createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const OWNER = fixture.keys.owner, GUEST = fixture.keys.guest; // synthetic fixture creds, local only
const J = { "Content-Type": "application/json" };
const auth = (k) => ({ ...J, Authorization: `Bearer ${k}` });
const fb = (url, extra = {}) => JSON.stringify({ url, formats: { markdown: true }, ...extra });

const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h || "");

async function send(c) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs ?? 12000);
  try {
    const r = await fetch(base + c.path, { method: c.method, headers: c.headers ?? {}, body: c.body ?? undefined, signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    const text = await r.text().catch(() => "");
    return { status: r.status, head: text.slice(0, 400), ms: Date.now() - started };
  } catch (e) {
    clearTimeout(timer);
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", head: String(e.message).slice(0, 200), ms: Date.now() - started };
  }
}

const C = [];
const add = (name, method, path, opts = {}) => C.push({ name, method, path, expect: opts.expect ?? null, headers: opts.headers, body: opts.body, timeoutMs: opts.timeoutMs });

// ---- auth gate ----
add("auth:none", "POST", "/api/web/fetch", { headers: J, body: fb(`${OP}/ok`), expect: [401] });
add("auth:bare-bearer", "POST", "/api/web/fetch", { headers: { ...J, Authorization: "Bearer" }, body: fb(`${OP}/ok`), expect: [401] });
add("auth:empty-token", "POST", "/api/web/fetch", { headers: { ...J, Authorization: "Bearer " }, body: fb(`${OP}/ok`), expect: [401] });
add("auth:garbage43", "POST", "/api/web/fetch", { headers: auth("q".repeat(43)), body: fb(`${OP}/ok`), expect: [401] });
add("auth:basic-scheme", "POST", "/api/web/fetch", { headers: { ...J, Authorization: "Basic abc123" }, body: fb(`${OP}/ok`), expect: [401] });
add("auth:guest", "POST", "/api/web/fetch", { headers: auth(GUEST), body: fb(`${OP}/ok`), expect: [403] });
add("auth:guest-get", "GET", "/api/web/fetch", { headers: auth(GUEST), expect: [405] });

// ---- method gate ----
add("m:get", "GET", "/api/web/fetch", { headers: auth(OWNER), expect: [405] });
add("m:put", "PUT", "/api/web/fetch", { headers: auth(OWNER), expect: [405] });
add("m:head", "HEAD", "/api/web/fetch", { headers: auth(OWNER), expect: [405] });

// ---- body shape ----
add("b:empty", "POST", "/api/web/fetch", { headers: auth(OWNER), body: "", expect: "4xx" });
add("b:truncated", "POST", "/api/web/fetch", { headers: auth(OWNER), body: '{"url":', expect: "4xx" });
add("b:array", "POST", "/api/web/fetch", { headers: auth(OWNER), body: "[1,2]", expect: "4xx" });
add("b:null", "POST", "/api/web/fetch", { headers: auth(OWNER), body: "null", expect: "4xx" });
add("b:string", "POST", "/api/web/fetch", { headers: auth(OWNER), body: '"x"', expect: "4xx" });
add("b:missing-url", "POST", "/api/web/fetch", { headers: auth(OWNER), body: JSON.stringify({ formats: { markdown: true } }), expect: [400] });
add("b:url-number", "POST", "/api/web/fetch", { headers: auth(OWNER), body: JSON.stringify({ url: 123 }), expect: [400] });
add("b:url-null", "POST", "/api/web/fetch", { headers: auth(OWNER), body: JSON.stringify({ url: null }), expect: [400] });
add("b:url-array", "POST", "/api/web/fetch", { headers: auth(OWNER), body: JSON.stringify({ url: ["http://x/"] }), expect: [400] });
add("b:url-empty", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(""), expect: [400] });
add("b:url-spaces", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("   "), expect: [400] });
add("b:url-2049", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://x/" + "y".repeat(2049)), expect: [400] });
add("b:url-2048", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://x/" + "y".repeat(2039)), expect: null }); // boundary: may 400 on DNS or 502
add("b:url-ftp", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("ftp://example.com/x"), expect: [400] });
add("b:url-javascript", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("javascript:alert(1)"), expect: [400] });
add("b:url-data", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("data:text/html,<p>x</p>"), expect: [400] });
add("b:url-userinfo", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://user:pass@example.com/"), expect: [400] });
add("b:url-badport", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://example.com:8080/"), expect: [400] });
add("b:url-unparseable", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://[::1"), expect: [400] });
add("b:url-nohost", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http:///path"), expect: [400] });

// ---- SSRF blocklist ----
add("s:private-10", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://10.0.0.1/"), expect: [403] });
add("s:private-192", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://192.168.1.1/"), expect: [403] });
add("s:linklocal", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://169.254.169.254/"), expect: [403] });
add("s:ipv6-mapped", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://[::ffff:10.0.0.1]/"), expect: [403] });
add("s:decimal-loopback-port", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`http://2130706433:${origin.address().port}/ok`), expect: [400], timeoutMs: 20000 });
add("s:hex-loopback-port", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`http://0x7f.0.0.1:${origin.address().port}/ok`), expect: [400], timeoutMs: 20000 });
add("s:unresolvable", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb("http://no-such-host-xyz987.invalid/"), expect: "4xx-5xx", timeoutMs: 30000 });

// ---- loopback origin scenarios (test-context allowance) ----
add("o:ok", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/ok`), expect: [200], timeoutMs: 20000 });
add("o:slow-headers", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/slow-headers`), expect: [504], timeoutMs: 30000 });
add("o:drip", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/drip`), expect: [504], timeoutMs: 40000 });
add("o:big", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/big`), expect: [502], timeoutMs: 30000 });
add("o:redir-loop", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/redir-loop`), expect: [502], timeoutMs: 20000 });
add("o:redir-private", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/redir-private`), expect: [403], timeoutMs: 20000 });
add("o:redir-file", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/redir-file`), expect: [403, 502], timeoutMs: 20000 });
add("o:redir-ok", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/redir-ok`), expect: [200], timeoutMs: 20000 });
add("o:redir-chain", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/redir-chain`), expect: [502], timeoutMs: 20000 });
add("o:notfound", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/notfound`), expect: [502], timeoutMs: 20000 });
add("o:servererror", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/servererror`), expect: [502], timeoutMs: 20000 });
add("o:nothtml", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/nothtml`), expect: [415], timeoutMs: 20000 });
add("o:noct-html", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/noct-html`), expect: [200], timeoutMs: 20000 });
add("o:gzip", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/gzip`), expect: [200], timeoutMs: 20000 });
add("o:gzip-bomb", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/gzip-bomb`), expect: [502], timeoutMs: 30000 });
add("o:charset-bogus", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/charset-bogus`), expect: [200], timeoutMs: 20000 });
add("o:empty-200", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/empty-200`), expect: [200, 415], timeoutMs: 20000 });

// ---- extra field / type edges on a valid URL ----
add("f:tags-string", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/ok`, { tags: "notarray" }), expect: null });
add("f:formats-string", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/ok`, { formats: "markdown" }), expect: null });
add("f:maxagems-negative", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/ok`, { maxAgeMs: -1 }), expect: null });
add("f:unknown-fields", "POST", "/api/web/fetch", { headers: auth(OWNER), body: fb(`${OP}/ok`, { __proto__: { x: 1 }, evil: true }), expect: null });

const findings = [];
for (const c of C) {
  const r = await send(c);
  let verdict = null;
  if (r.status === 500) verdict = "unexpected-500";
  else if (r.status === "TIMEOUT") verdict = "hang";
  else if (r.status === "FETCH-ERROR") verdict = "transport-anomaly";
  else if (looksLikeStack(r.head)) verdict = "possible-stack-leak";
  if (!verdict && c.expect) {
    const ok = c.expect === "4xx" ? (typeof r.status === "number" && r.status >= 400 && r.status < 500)
      : c.expect === "4xx-5xx" ? (typeof r.status === "number" && r.status >= 400 && r.status < 600)
      : c.expect.includes(r.status);
    if (!ok) verdict = `wrong-status (expected ${JSON.stringify(c.expect)}, got ${r.status})`;
  }
  const rec = { case: c.name, method: c.method, status: r.status, ms: r.ms, head: r.head.slice(0, 200), expect: c.expect, verdict };
  if (verdict) { findings.push(rec); console.log(`FINDING ${c.name}: ${verdict} — ${r.status} ${(r.head || "").slice(0, 120)}`); }
  else console.log(`ok ${c.name}: ${r.status} (${r.ms}ms)`);
}

try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
try { fixture.store.close(); } catch {}
await new Promise(r => origin.close(r));
writeFileSync(new URL("./findings-webfetch.json", import.meta.url), JSON.stringify({ cases: C.length, findings }, null, 1));
console.log(`done: ${findings.length}/${C.length} anomalous -> worker-23/findings-webfetch.json`);
