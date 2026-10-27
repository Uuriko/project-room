// VL-1a runtime OG renderer. The golden hash is the PNG bytes of one fixed
// input, so a layout or atlas change fails here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { OG_HEIGHT, OG_WIDTH, renderOgPng, sanitizeOgText, wrapOgText } from "../server/og-render.mjs";

const OG_FILES = ["og/atlas.json", "og/atlas-inter-24.png", "og/atlas-inter-32.png", "og/atlas-inter-48.png", "og/base-receipt.png"];

// The Worker-shaped loader: bytes served from memory, keyed by the exact
// asset paths the ASSETS binding serves after build-assets.mjs bundles them.
function memoryLoader() {
  const bytes = new Map(OG_FILES.map(path => [path, readFileSync(new URL("../" + path, import.meta.url))]));
  const requested = [];
  const loadAsset = async path => {
    requested.push(path);
    const data = bytes.get(path);
    if (!data) throw new Error(`unexpected og asset request: ${path}`);
    return data;
  };
  return { loadAsset, requested };
}

const atlas = JSON.parse(readFileSync(new URL("../og/atlas.json", import.meta.url), "utf8"));
const GOLDEN = "8be24cd4a63e7f43b33b20584c1b24594910bfe4b1f3b6755eedcb3831199a71";

function ihdr(png) {
  assert.equal(Buffer.from(png.subarray(0, 8)).toString("hex"), "89504e470d0a1a0a");
  assert.equal(Buffer.from(png.subarray(12, 16)).toString("ascii"), "IHDR");
  const view = new DataView(png.buffer, png.byteOffset + 16, 13);
  return { width: view.getUint32(0), height: view.getUint32(4), depth: png[24], color: png[25] };
}

test("a receipt card is a 1200 by 630 PNG and a fixed input keeps its bytes", async () => {
  const png = await renderOgPng({
    title: "Ship the receipt",
    subtitle: "Closed by Ada",
    badges: ["CI passing", "Merged"],
    footer: "Made in Project Room",
  });
  const header = ihdr(png);
  assert.equal(header.width, OG_WIDTH);
  assert.equal(header.height, OG_HEIGHT);
  assert.equal(header.depth, 8);
  assert.equal(header.color, 6);
  assert.equal(createHash("sha256").update(png).digest("hex"), GOLDEN);
});

test("a long title wraps to three lines and ends with an ellipsis", () => {
  const lines = wrapOgText("M".repeat(200), { size: 48, maxWidth: OG_WIDTH - 144, maxLines: 3, atlas });
  assert.equal(lines.length, 3);
  assert.equal(lines[2].endsWith("…"), true);
  assert.equal(lines[2].includes("MMMM"), true);
  assert.deepEqual(wrapOgText("Short title", { size: 48, maxWidth: OG_WIDTH - 144, maxLines: 3, atlas }), ["Short title"]);
});

test("control characters are stripped and do not change the image", async () => {
  assert.equal(sanitizeOgText(`Hel\u0000lo\u0007`), "Hello");
  assert.equal(sanitizeOgText("a".repeat(130)).length, 120);
  const clean = await renderOgPng({ title: "Hello", subtitle: "World", badges: ["CI"], footer: "Made in Project Room" });
  const dirty = await renderOgPng({ title: "Hel\u0000lo", subtitle: "Wor\u0007ld", badges: ["C\u0001I"], footer: "Made in Project Room" });
  assert.deepEqual(dirty, clean);
});

test("an injected loader renders the golden card and is asked for exactly the bundled og assets", async () => {
  const { loadAsset, requested } = memoryLoader();
  const png = await renderOgPng({
    title: "Ship the receipt",
    subtitle: "Closed by Ada",
    badges: ["CI passing", "Merged"],
    footer: "Made in Project Room",
  }, { loadAsset });
  assert.equal(createHash("sha256").update(png).digest("hex"), GOLDEN);
  assert.deepEqual([...requested].sort(), [...OG_FILES].sort());
});

test("the render path never touches node:fs when a loader is injected (Worker shape)", async t => {
  // Copy the renderer alone into an empty directory: its ../og does not
  // exist there, so any filesystem read on the render path would fail with
  // ENOENT. The injected in-memory loader must carry the whole render.
  const directory = mkdtempSync(join(tmpdir(), "og-render-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const copy = join(directory, "og-render.mjs");
  copyFileSync(new URL("../server/og-render.mjs", import.meta.url), copy);
  const isolated = await import(pathToFileURL(copy).href);
  const { loadAsset } = memoryLoader();
  const png = await isolated.renderOgPng({
    title: "Ship the receipt",
    subtitle: "Closed by Ada",
    badges: ["CI passing", "Merged"],
    footer: "Made in Project Room",
  }, { loadAsset });
  assert.equal(createHash("sha256").update(png).digest("hex"), GOLDEN);
  // The same isolated module without a loader falls back to node:fs and
  // fails here, proving the loader — not the disk — carried the render above.
  await assert.rejects(isolated.renderOgPng({ title: "Hello" }), /ENOENT/);
});

test("a receipt og.png serves 200 through a loader backed only by the build-assets output (ASSETS shape)", async t => {
  const { buildAssets } = await import("../cloudflare/build-assets.mjs");
  const { RoomStore } = await import("../server/store.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const { projectPublicWorkReceipt } = await import("../server/receipts-live.mjs");
  const { readFile } = await import("node:fs/promises");
  const output = pathToFileURL(join(mkdtempSync(join(tmpdir(), "og-assets-")), "/"));
  t.after(() => rmSync(new URL(output), { recursive: true, force: true }));
  await buildAssets(output);
  // The production seam (cloudflare/room.mjs): bytes come from the ASSETS
  // binding, i.e. from exactly this build output — never the repo tree.
  const loadAsset = path => readFile(new URL(path, output));
  const directory = mkdtempSync(join(tmpdir(), "og-server-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const PWR = `pwr_${"cd".repeat(32)}`;
  const publicWork = { schema: "public-work-receipt/1", receiptId: PWR, namespaceId: "commons", identityId: "ai_public", title: "Public task", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: "cd".repeat(32) } };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    PWR, "offer-1", "commons", 1, "ai_public", "note", "cd".repeat(32), 4, JSON.stringify(publicWork), Date.now());
  projectPublicWorkReceipt(store, publicWork, "cd".repeat(32));
  const server = createRoomServer({ store, loadAsset });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/receipts/${PWR}/og.png`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /image\/png/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.length > 1000, `og.png should be a rendered card, got ${bytes.length} bytes`);
});

test("a three-line title renders within the loose time bound", async () => {
  const started = performance.now();
  const png = await renderOgPng({
    title: "M".repeat(120),
    subtitle: "Closed by Ada",
    badges: ["CI passing"],
    footer: "Made in Project Room",
  });
  const elapsed = performance.now() - started;
  assert.equal(ihdr(png).width, 1200);
  assert.ok(elapsed <= 200, `3-line title rendered in ${elapsed.toFixed(1)} ms`);
});
