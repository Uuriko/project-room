import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";

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
  // Peel every coding the header names, in reverse order of application,
  // then keep peeling gzip layers while the gzip magic survives: at head
  // 984a76c9 the hosted cloudflare job (run 40799927548, job 123209136557)
  // still failed 12 checks with gzip magic bytes after a single peel, so
  // the wire body can carry more than one gzip layer (a repeated coding,
  // or a transport-added layer the moved header does not name). Bounded;
  // each gzip peel is magic-verified, and a peel that throws keeps the
  // last good bytes.
  let body = bytes;
  let peeled = false;
  const codings = encoding.split(",").map(coding => coding.trim().toLowerCase()).reverse();
  const peel = (coding, buf) => {
    if ((coding === "gzip" || coding === "x-gzip") && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
    if (coding === "br") return brotliDecompressSync(buf);
    if (coding === "deflate") return inflateSync(buf);
    return null;
  };
  for (const coding of codings) {
    try {
      const next = peel(coding, body);
      if (!next) break;
      body = next; peeled = true;
    } catch { break; }
  }
  for (let extra = 0; extra < 3 && body[0] === 0x1f && body[1] === 0x8b; extra++) {
    try { body = gunzipSync(body); peeled = true; } catch { break; }
  }
  if (!peeled) {
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const headers = new Headers(response.headers);
  headers.delete("mf-content-encoding");
  headers.delete("content-encoding");
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
