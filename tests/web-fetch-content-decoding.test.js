import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { fetchPage, WEB_FETCH_MAX_BODY_BYTES, WebFetchError } from "../server/web-fetch.mjs";

async function withPage(t, encoding, payload, run) {
  const previous = process.env.WEB_FETCH_ALLOW_LOOPBACK;
  process.env.WEB_FETCH_ALLOW_LOOPBACK = "1";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": encoding });
    res.end(payload);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (previous === undefined) delete process.env.WEB_FETCH_ALLOW_LOOPBACK;
    else process.env.WEB_FETCH_ALLOW_LOOPBACK = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await run(`http://127.0.0.1:${server.address().port}/`);
}

for (const [encoding, compress] of Object.entries({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })) {
  test(`Node fetch decodes ${encoding} HTML before returning bytes`, async t => {
    const html = "<html><body><h1>Readable café</h1></body></html>";
    await withPage(t, encoding, compress(Buffer.from(html)), async url => {
      const result = await fetchPage(url);
      assert.equal(result.html, html);
      assert.equal(result.bytes, Buffer.byteLength(html));
    });
  });
  test(`Node fetch caps expanded ${encoding} HTML`, async t => {
    const payload = compress(Buffer.from("x".repeat(WEB_FETCH_MAX_BODY_BYTES + 1)));
    assert.ok(payload.length < WEB_FETCH_MAX_BODY_BYTES);
    await withPage(t, encoding, payload, async url => {
      await assert.rejects(fetchPage(url), error => error instanceof WebFetchError
        && error.status === 502 && error.code === "fetch_failed" && /body exceeds/.test(error.message));
    });
  });
}

test("Node fetch rejects corrupt compressed streams with a typed error", async t => {
  await withPage(t, "gzip", Buffer.from("not gzip"), async url => {
    await assert.rejects(fetchPage(url), error => error instanceof WebFetchError
      && error.status === 502 && error.code === "fetch_failed");
  });
});

test("Node fetch rejects unsupported content encoding explicitly", async t => {
  await withPage(t, "gzip, br", Buffer.from("<html>encoded</html>"), async url => {
    await assert.rejects(fetchPage(url), error => error instanceof WebFetchError
      && error.status === 415 && error.code === "unsupported_content");
  });
});
