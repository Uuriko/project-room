// B4-a (PERF-50): the Worker sent every JSON response uncompressed, while
// gzip-6 on the captured real bodies saved 57–84% of wire bytes (the full
// tools/list is 160 KB raw, ~25.5 KB gzipped; B4 measured production
// responses carrying no Content-Encoding at all). Compression is a
// CPU-for-bytes trade that wins clearly at/above ~2 KB and loses on tiny
// replies, so only JSON responses at/above the threshold are encoded.
//
// Boundaries, all deliberate:
// - gzip only. The Worker runtime's CompressionStream offers gzip/deflate,
//   not brotli; gzip is what B4-a priced.
// - The client must offer gzip in Accept-Encoding (an explicit `gzip`
//   token, or `*` without an explicit gzip refusal), q-values honoured.
// - Already-encoded responses are never re-encoded, Content-Range and
//   `Cache-Control: no-transform` responses pass through untouched, and
//   bodyless / 204 / 205 / 304 responses pass through.
// - Streaming shapes never reach the encoder: the content-type gate admits
//   only application/json and *+json, so SSE (text/event-stream) and NDJSON
//   exports keep streaming. JSON responses in this codebase are finite
//   request/response bodies, and an unknown-length JSON body is buffered
//   only to measure it against the threshold — a body that turns out to be
//   under the threshold is returned byte-identical, unencoded.
// - A strong ETag is dropped on encode (the representation changed; a weak
//   ETag stays valid across encodings), Content-Length is rewritten to the
//   compressed size, and `Vary: Accept-Encoding` is merged in.

export const JSON_COMPRESSION_THRESHOLD_BYTES = 2048;

// Parse an Accept-Encoding header value into a Map of token -> q value.
// A malformed q is treated as 1 (the token was still offered); a missing
// header parses to an empty map (nothing was offered).
export function parseAcceptEncoding(header) {
  const offered = new Map();
  if (typeof header !== "string") return offered;
  for (const part of header.split(",")) {
    const [token, ...params] = part.split(";");
    const name = token.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map(piece => piece.trim());
      if (key.toLowerCase() === "q") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
      }
    }
    offered.set(name, q);
  }
  return offered;
}

export function acceptsGzip(header) {
  const offered = parseAcceptEncoding(header);
  if (offered.has("gzip")) return offered.get("gzip") > 0;
  if (offered.has("identity") && offered.get("identity") === 0 && !offered.has("*")) return false;
  return (offered.get("*") ?? 0) > 0;
}

function isJsonContentType(contentType) {
  if (typeof contentType !== "string") return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "application/json" || base.endsWith("+json");
}

// Cheap eligibility from headers alone. When this returns false the body
// is never read, so a known-small JSON response (Content-Length below the
// threshold) and every non-JSON stream pass through at zero cost.
export function compressionEligible(request, response) {
  if (!request || !response || response.body === null) return false;
  const method = String(request.method ?? "GET").toUpperCase();
  if (method === "HEAD") return false;
  const status = response.status;
  if (status < 200 || status === 204 || status === 205 || status === 304) return false;
  const headers = response.headers;
  const encoding = headers.get("Content-Encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") return false;
  if (headers.has("Content-Range")) return false;
  const cacheControl = headers.get("Cache-Control") ?? "";
  if (/(?:^|,)\s*no-transform(?:\s|,|$)/i.test(cacheControl)) return false;
  if (!isJsonContentType(headers.get("Content-Type"))) return false;
  if (!acceptsGzip(request.headers?.get?.("Accept-Encoding"))) return false;
  const declared = Number(headers.get("Content-Length"));
  if (Number.isFinite(declared) && headers.has("Content-Length") && declared < JSON_COMPRESSION_THRESHOLD_BYTES) return false;
  return true;
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function withVary(headers) {
  const existing = headers.get("Vary");
  if (existing === "*") return;
  const parts = existing ? existing.split(",").map(part => part.trim()).filter(Boolean) : [];
  if (!parts.some(part => part.toLowerCase() === "accept-encoding")) parts.push("Accept-Encoding");
  headers.set("Vary", parts.join(", "));
}

// Encode one response when it qualifies; otherwise return it untouched
// (same object, body never consumed). A body buffered for measuring that
// falls under the threshold, or that gzip cannot shrink, is returned as a
// byte-identical unencoded response.
export async function compressJsonResponse(request, response) {
  if (!compressionEligible(request, response)) return response;
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength < JSON_COMPRESSION_THRESHOLD_BYTES) {
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const compressed = await gzipBytes(raw);
  if (compressed.byteLength >= raw.byteLength) {
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compressed.byteLength));
  const etag = headers.get("ETag");
  if (etag && !etag.trimStart().startsWith("W/")) headers.delete("ETag");
  withVary(headers);
  return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
}
