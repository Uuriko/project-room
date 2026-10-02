// VL-1a runtime OG renderer. The golden hash is the PNG bytes of one fixed
// input, so a layout or atlas change fails here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OG_HEIGHT, OG_WIDTH, renderOgPng, sanitizeOgText, wrapOgText } from "../server/og-render.mjs";

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
