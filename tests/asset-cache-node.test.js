import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

// #4065: the Node asset path must answer the same Cache-Control/ETag
// behaviour as the Cloudflare edge (cloudflare/edge-public.mjs): scripts,
// styles, SVG and the web manifest revalidate (no-cache) against a SHA-256
// content ETag with 304 on If-None-Match; other images and fonts get a
// one-day cache; HTML keeps no policy and no ETag.

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-asset-cache-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

const repoRoot = new URL("../", import.meta.url);
// The edge ETag: first 16 bytes of the SHA-256 of the bytes, hex, quoted.
const expectedEtag = file => `"${createHash("sha256").update(readFileSync(new URL(file, repoRoot))).digest("hex").slice(0, 32)}"`;

test("Node asset path matches the edge cache/ETag policy (#4065)", async t => {
  const origin = await serve(t);

  const script = await fetch(origin + "/src/app.js");
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("cache-control"), "no-cache");
  const etag = script.headers.get("etag");
  assert.equal(etag, expectedEtag("src/app.js"), "ETag is the content SHA-256 prefix, as at the edge");
  assert.match(await script.text(), /./);

  const again = await fetch(origin + "/src/app.js");
  assert.equal(again.headers.get("etag"), etag, "the ETag is stable for unchanged bytes");

  const notModified = await fetch(origin + "/src/app.js", { headers: { "If-None-Match": etag } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), etag);
  assert.equal(notModified.headers.get("cache-control"), "no-cache");
  assert.equal((await notModified.text()).length, 0);

  const weak = await fetch(origin + "/src/app.js", { headers: { "If-None-Match": `W/${etag}` } });
  assert.equal(weak.status, 304, "a weak validator matches, as at the edge");

  const stale = await fetch(origin + "/src/app.js", { headers: { "If-None-Match": '"stale"' } });
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("etag"), etag);

  const head = await fetch(origin + "/src/app.js", { method: "HEAD", headers: { "If-None-Match": etag } });
  assert.equal(head.status, 304);

  const style = await fetch(origin + "/src/styles.css");
  assert.equal(style.status, 200);
  assert.equal(style.headers.get("cache-control"), "no-cache");
  assert.equal(style.headers.get("etag"), expectedEtag("src/styles.css"));

  const svg = await fetch(origin + "/favicon.svg");
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("cache-control"), "no-cache");
  assert.equal(svg.headers.get("etag"), expectedEtag("favicon.svg"));

  const manifest = await fetch(origin + "/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("cache-control"), "no-cache");
  assert.equal(manifest.headers.get("etag"), expectedEtag("manifest.webmanifest"));

  const png = await fetch(origin + "/og/home.png");
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(png.headers.get("etag"), expectedEtag("og/home.png"));

  const font = await fetch(origin + "/og/fonts/Inter-Regular.ttf");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(font.headers.get("etag"), expectedEtag("og/fonts/Inter-Regular.ttf"));

  const shell = await fetch(origin + "/");
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("etag"), null, "HTML keeps no ETag, as at the edge");
  assert.equal(shell.headers.get("cache-control"), "no-store", "HTML keeps the server-wide no-store default");
});
