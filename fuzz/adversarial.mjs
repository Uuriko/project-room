// WAVE-2000 GUILD-02 adversarial case generators.
// A "case" is a plain request descriptor the runner sends via fetch or raw socket.
const OVERSIZE = "x".repeat(20 * 1024); // > JSON_BODY_BYTES (16384)
const HUGE_QUERY = "q=" + "y".repeat(8192);
const BIG_HEADER = "z".repeat(16384);

export function methodMatrix(path, note = "") {
  const cases = [];
  for (const m of ["PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND"]) {
    cases.push({ name: `method-matrix:${m}${note ? ":" + note : ""}`, method: m, path, headers: {}, body: null, timeoutMs: 8000 });
  }
  // fetch(3) cannot send TRACE; use a raw socket for it.
  cases.push({ name: `method-matrix:TRACE${note ? ":" + note : ""}`, raw: true, payload: `TRACE ${path} HTTP/1.1\r\nHost: x\r\n\r\n`, timeoutMs: 8000 });
  return cases;
}

export function jsonCases(path, method = "POST", extraHeaders = {}) {
  const J = { "Content-Type": "application/json" };
  const H = { ...J, ...extraHeaders };
  return [
    { name: "json:truncated", method, path, headers: H, body: '{"a":', timeoutMs: 8000 },
    { name: "json:bare-brace", method, path, headers: H, body: '{', timeoutMs: 8000 },
    { name: "json:array", method, path, headers: H, body: '[1,2,3]', timeoutMs: 8000 },
    { name: "json:null", method, path, headers: H, body: 'null', timeoutMs: 8000 },
    { name: "json:string", method, path, headers: H, body: '"hello"', timeoutMs: 8000 },
    { name: "json:number", method, path, headers: H, body: '42', timeoutMs: 8000 },
    { name: "json:deep-nest", method, path, headers: H, body: '{"a":'.repeat(400) + '1' + '}'.repeat(400), timeoutMs: 8000 },
    { name: "json:dup-keys", method, path, headers: H, body: '{"a":1,"a":2}', timeoutMs: 8000 },
    { name: "json:oversize-20k", method, path, headers: H, body: JSON.stringify({ a: OVERSIZE }), timeoutMs: 15000 },
    { name: "json:empty-body", method, path, headers: H, body: '', timeoutMs: 8000 },
    { name: "json:whitespace", method, path, headers: H, body: '   \n\t ', timeoutMs: 8000 },
    { name: "json:unicode-bom", method, path, headers: H, body: '﻿{"a":1}', timeoutMs: 8000 },
    { name: "json:proto-pollution", method, path, headers: H, body: '{"__proto__":{"x":1},"constructor":{"prototype":{"y":2}}}', timeoutMs: 8000 },
    { name: "json:no-content-type", method, path, headers: { ...extraHeaders }, body: '{"a":1}', timeoutMs: 8000 },
    { name: "json:text-plain", method, path, headers: { "Content-Type": "text/plain", ...extraHeaders }, body: '{"a":1}', timeoutMs: 8000 },
    { name: "json:charset-param", method, path, headers: { "Content-Type": "application/json; charset=latin1", ...extraHeaders }, body: '{"a":1}', timeoutMs: 8000 },
    { name: "json:null-byte-in-string", method, path, headers: H, body: '{"a":"b\u0000c"}', timeoutMs: 8000 },
    { name: "json:bigint-literal", method, path, headers: H, body: '{"a":900719925474099312345678}', timeoutMs: 8000 },
  ];
}

export function invalidUtf8Case(path, method = "POST") {
  return { name: "json:invalid-utf8", method, path, headers: { "Content-Type": "application/json" }, raw: Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('"}')]), timeoutMs: 8000 };
}

export function queryCases(path) {
  return [
    { name: "query:huge-8k", method: "GET", path: path + "?" + HUGE_QUERY, headers: {}, body: null, timeoutMs: 8000 },
    { name: "query:null-byte", method: "GET", path: path + "?a=%00", headers: {}, body: null, timeoutMs: 8000 },
    { name: "query:dotdot-encoded", method: "GET", path: path + "?a=%2e%2e%2f%2e%2e%2fetc", headers: {}, body: null, timeoutMs: 8000 },
    { name: "query:dup-keys", method: "GET", path: path + "?a=1&a=2&a[]=3", headers: {}, body: null, timeoutMs: 8000 },
    { name: "query:empty", method: "GET", path: path + "?", headers: {}, body: null, timeoutMs: 8000 },
    { name: "query:unicode", method: "GET", path: path + "?a=" + encodeURIComponent("🪔✓ñ"), headers: {}, body: null, timeoutMs: 8000 },
  ];
}

export function headerCases(path, method = "POST") {
  const body = (method === "GET" || method === "HEAD") ? null : '{"a":1}';
  return [
    { name: "hdr:16k-value", method, path, headers: { "Content-Type": "application/json", "X-Big": BIG_HEADER }, body, timeoutMs: 8000 },
    { name: "hdr:host-spoof", method, path, headers: { "Content-Type": "application/json", Host: "evil.example.com" }, body, timeoutMs: 8000, rawHeaders: true },
    { name: "hdr:origin-foreign", method, path, headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" }, body, timeoutMs: 8000 },
    { name: "hdr:origin-missing-post", method, path, headers: { "Content-Type": "application/json" }, body, timeoutMs: 8000 },
    { name: "hdr:xff-chain", method, path, headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4, 5.6.7.8, 127.0.0.1" }, body, timeoutMs: 8000 },
    { name: "hdr:bearer-garbage", method, path, headers: { "Content-Type": "application/json", Authorization: "Bearer " + "q".repeat(4096) }, body, timeoutMs: 8000 },
    { name: "hdr:cookie-huge", method, path, headers: { "Content-Type": "application/json", Cookie: "s=" + "c".repeat(16384) }, body, timeoutMs: 8000 },
  ];
}

// Raw-socket HTTP abuses (node's parser + server robustness).
export function rawSocketCases() {
  const bad = [];
  bad.push({ name: "raw:bad-request-line", payload: "HELLO WORLD\r\n\r\n", timeoutMs: 5000 });
  bad.push({ name: "raw:no-headers-terminator", payload: "GET /api/health HTTP/1.1\r\nHost: x", timeoutMs: 5000 });
  bad.push({ name: "raw:huge-header-line", payload: "GET /api/health HTTP/1.1\r\nHost: x\r\nX-Big: " + "z".repeat(200000) + "\r\n\r\n", timeoutMs: 8000 });
  bad.push({ name: "raw:content-length-lie-big", payload: "POST /api/health HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000000\r\n\r\n{\"a\":1}", timeoutMs: 8000 });
  bad.push({ name: "raw:content-length-lie-small", payload: "POST /api/health HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{\"a\":12345}", timeoutMs: 8000 });
  bad.push({ name: "raw:chunked-invalid", payload: "POST /api/health HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\nhello\r\n0\r\n\r\n", timeoutMs: 8000 });
  bad.push({ name: "raw:double-content-length", payload: "GET /api/health HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 0\r\n\r\n", timeoutMs: 8000 });
  bad.push({ name: "raw:http09", payload: "GET /api/health\r\n", timeoutMs: 5000 });
  bad.push({ name: "raw:null-in-path", payload: "GET /api/health\x00 HTTP/1.1\r\nHost: x\r\n\r\n", timeoutMs: 5000 });
  bad.push({ name: "raw:absolute-uri", payload: "GET http://evil.example.com/api/health HTTP/1.1\r\nHost: evil.example.com\r\n\r\n", timeoutMs: 5000 });
  return bad;
}
