import { gunzipSync, brotliDecompressSync } from "node:zlib";

// Harness boundary for Miniflare dispatchFetch responses.
//
// dispatchFetch returns the raw wire body: it moves Content-Encoding to
// MF-Content-Encoding and does not decode. It also rewrites the request's
// Accept-Encoding on the way in — an echo-worker probe at the lockfile
// versions (miniflare 4.20260730.0 / undici 7.29.1) shows the Worker
// receives "br, gzip" whether the caller offered identity, gzip, or
// nothing — so offering `Accept-Encoding: identity` in a check helper
// cannot stop the Worker from gzipping a JSON body at/above its 2 KB
// threshold, and the gzipped bytes then reach the checks' .json() /
// .text() reads untouched (SyntaxError on the gzip magic bytes).
//
// Decode here instead, where the transport cannot override it: when a
// response names a wire encoding (MF-Content-Encoding, or
// Content-Encoding on a path that kept it), replace the body with its
// decoded bytes — the body a decoding production client (browser fetch,
// Node fetch) would hand to the same .json() call. Responses without a
// wire encoding pass through by identity (same object, body never read),
// and a body whose bytes do not match the named encoding (already
// decoded upstream) is returned as a plain response over the same bytes,
// so the helper is safe to apply twice or across mixed transports.
export async function decodeDispatchResponse(response) {
  response = await response;
  const encoding = response?.headers?.get?.("mf-content-encoding")
    ?? response?.headers?.get?.("content-encoding");
  if (!encoding || encoding.trim().toLowerCase() === "identity") return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  let body = null;
  try {
    if (encoding.includes("gzip") && bytes[0] === 0x1f && bytes[1] === 0x8b) body = gunzipSync(bytes);
    else if (encoding.includes("br")) body = brotliDecompressSync(bytes);
  } catch { body = null; }
  if (!body) {
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const headers = new Headers(response.headers);
  headers.delete("mf-content-encoding");
  headers.delete("content-encoding");
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
