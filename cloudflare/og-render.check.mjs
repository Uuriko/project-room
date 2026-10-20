import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

// Regression check for the production receipt og.png 500 (2026-10-20):
// under the worker bundle import.meta.url is undefined, so the renderer's
// disk asset path computation threw ERR_INVALID_ARG_TYPE and every receipt
// share card failed while the Node test suite stayed green. The renderer
// must serve from its embedded asset fallback in this runtime.
test("runtime OG renderer serves a PNG under the worker runtime", async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("./og-render.test-fixture.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"] });
  try {
    const res = await mf.dispatchFetch("https://room.example.test/receipts/wir_x/og.png");
    assert.equal(res.status, 200, await res.clone().text().catch(() => ""));
    assert.match(res.headers.get("content-type") ?? "", /image\/png/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [137, 80, 78, 71]);
    assert.ok(bytes.length > 1000, `expected a rendered card, got ${bytes.length} bytes`);
  } finally {
    await mf.dispose();
  }
});
