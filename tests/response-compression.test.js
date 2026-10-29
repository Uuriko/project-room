import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  JSON_COMPRESSION_THRESHOLD_BYTES,
  acceptsGzip,
  compressJsonResponse
} from "../cloudflare/response-compression.mjs";
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { listedMcpTools } from "../server/mcp-discovery.mjs";

// B4-a (PERF-50): production sent JSON uncompressed; gzip saves 57–84% on
// the real bodies. The Worker now gzips JSON responses >=2 KB when the
// client offers gzip. These tests pin the encode, the threshold, the
// negotiation, and every pass-through shape.

const gzipRequest = (extra = {}) => new Request("https://room.example/mcp", {
  headers: { "Accept-Encoding": "gzip", ...extra }
});

function jsonResponse(body, headers = {}) {
  const bytes = new TextEncoder().encode(body);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      ...headers
    }
  });
}

// A JSON body of an exact byte size (an ASCII pad field keeps it valid JSON).
function jsonBodyOfSize(size) {
  const skeleton = JSON.stringify({ pad: "" });
  const body = JSON.stringify({ pad: "x".repeat(size - skeleton.length) });
  assert.equal(new TextEncoder().encode(body).byteLength, size);
  return body;
}

test("acceptsGzip honours q-values, wildcards and explicit refusals", () => {
  assert.equal(acceptsGzip("gzip"), true);
  assert.equal(acceptsGzip("br, gzip"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false);
  assert.equal(acceptsGzip("gzip;q=0, *;q=1"), false);
  assert.equal(acceptsGzip("*"), true);
  assert.equal(acceptsGzip("*;q=0"), false);
  assert.equal(acceptsGzip("deflate"), false);
  assert.equal(acceptsGzip("identity"), false);
  assert.equal(acceptsGzip(undefined), false);
  assert.equal(acceptsGzip(""), false);
});

test("a >=2 KB JSON response is gzipped and decodes byte-identically", async () => {
  const body = jsonBodyOfSize(8192);
  const out = await compressJsonResponse(gzipRequest(), jsonResponse(body));
  assert.equal(out.headers.get("Content-Encoding"), "gzip");
  const wire = new Uint8Array(await out.arrayBuffer());
  assert.equal(Number(out.headers.get("Content-Length")), wire.byteLength);
  assert.ok(wire.byteLength < body.length / 2, `expected a large saving, got ${wire.byteLength} of ${body.length}`);
  assert.equal(gunzipSync(wire).toString("utf8"), body);
  assert.match(out.headers.get("Vary") ?? "", /Accept-Encoding/);
});

test("the real full tools/list body lands in the B4 target class (~160 KB -> ~25 KB)", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: listedMcpTools("full") } });
  const rawBytes = new TextEncoder().encode(body).byteLength;
  assert.ok(rawBytes > 150_000, `full catalog should exceed 150 KB, got ${rawBytes}`);
  const out = await compressJsonResponse(gzipRequest(), jsonResponse(body));
  assert.equal(out.headers.get("Content-Encoding"), "gzip");
  const wire = new Uint8Array(await out.arrayBuffer());
  assert.ok(wire.byteLength < 32_000, `expected ~25 KB wire size, got ${wire.byteLength}`);
  assert.equal(gunzipSync(wire).toString("utf8"), body);
});

test("the real anonymous tools/list body (4,871 B) gzips to the B4-measured 1,663 B class", async () => {
  const body = JSON.stringify(handleMcpJoinRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(new TextEncoder().encode(body).byteLength, 4871);
  const out = await compressJsonResponse(gzipRequest(), jsonResponse(body));
  assert.equal(out.headers.get("Content-Encoding"), "gzip");
  const wire = new Uint8Array(await out.arrayBuffer());
  assert.ok(wire.byteLength >= 1500 && wire.byteLength <= 1800, `expected ~1,663 B, got ${wire.byteLength}`);
  assert.equal(gunzipSync(wire).toString("utf8"), body);
});

test("below the threshold nothing is encoded, at the threshold it is", async () => {
  const small = jsonBodyOfSize(JSON_COMPRESSION_THRESHOLD_BYTES - 1);
  const smallOut = await compressJsonResponse(gzipRequest(), jsonResponse(small));
  assert.equal(smallOut.headers.get("Content-Encoding"), null);
  assert.equal(await smallOut.text(), small);
  const atThreshold = jsonBodyOfSize(JSON_COMPRESSION_THRESHOLD_BYTES);
  const bigOut = await compressJsonResponse(gzipRequest(), jsonResponse(atThreshold));
  assert.equal(bigOut.headers.get("Content-Encoding"), "gzip");
  assert.equal(gunzipSync(new Uint8Array(await bigOut.arrayBuffer())).toString("utf8"), atThreshold);
});

test("a known-small response is returned untouched without consuming its body", async () => {
  const body = jsonBodyOfSize(512);
  const response = jsonResponse(body);
  const out = await compressJsonResponse(gzipRequest(), response);
  assert.equal(out, response);
});

test("an unknown-length JSON body under the threshold comes back byte-identical and unencoded", async () => {
  const body = jsonBodyOfSize(1024);
  const response = new Response(new TextEncoder().encode(body), {
    status: 200, headers: { "Content-Type": "application/json; charset=utf-8" }
  });
  const out = await compressJsonResponse(gzipRequest(), response);
  assert.equal(out.headers.get("Content-Encoding"), null);
  assert.equal(await out.text(), body);
});

test("no gzip on offer means no encoding", async () => {
  const body = jsonBodyOfSize(8192);
  for (const headers of [{}, { "Accept-Encoding": "deflate" }, { "Accept-Encoding": "gzip;q=0" }, { "Accept-Encoding": "br" }]) {
    const request = new Request("https://room.example/mcp", { headers });
    const response = jsonResponse(body);
    const out = await compressJsonResponse(request, response);
    assert.equal(out, response, `headers ${JSON.stringify(headers)} must pass through`);
  }
});

test("already-encoded, ranged and no-transform responses are never double-encoded", async () => {
  const body = jsonBodyOfSize(8192);
  for (const headers of [
    { "Content-Encoding": "gzip" },
    { "Content-Encoding": "br" },
    { "Content-Range": "bytes 0-8191/16384" },
    { "Cache-Control": "no-store, no-transform" }
  ]) {
    const response = jsonResponse(body, headers);
    const out = await compressJsonResponse(gzipRequest(), response);
    assert.equal(out, response, `headers ${JSON.stringify(headers)} must pass through`);
  }
});

test("streaming and non-JSON shapes pass through: SSE, plain text, bodyless and HEAD", async () => {
  const big = "x".repeat(8192);
  const sse = new Response(big, { status: 200, headers: { "Content-Type": "text/event-stream", "Content-Length": String(big.length) } });
  assert.equal(await compressJsonResponse(gzipRequest(), sse), sse);
  const text = new Response(big, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(big.length) } });
  assert.equal(await compressJsonResponse(gzipRequest(), text), text);
  const bodyless = new Response(null, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  assert.equal(await compressJsonResponse(gzipRequest(), bodyless), bodyless);
  const head = new Request("https://room.example/mcp", { method: "HEAD", headers: { "Accept-Encoding": "gzip" } });
  const headResponse = jsonResponse(jsonBodyOfSize(8192));
  assert.equal(await compressJsonResponse(head, headResponse), headResponse);
});

test("a strong ETag is dropped on encode and a weak one is kept", async () => {
  const body = jsonBodyOfSize(8192);
  const strong = await compressJsonResponse(gzipRequest(), jsonResponse(body, { ETag: '"abc123"' }));
  assert.equal(strong.headers.get("ETag"), null);
  const weak = await compressJsonResponse(gzipRequest(), jsonResponse(body, { ETag: 'W/"abc123"' }));
  assert.equal(weak.headers.get("ETag"), 'W/"abc123"');
});
