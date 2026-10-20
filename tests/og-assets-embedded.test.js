import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMBEDDED_OG_ASSETS } from "../server/og-assets-embedded.mjs";
import { decodeBase64, loadEmbeddedOgAssets, OG_WIDTH, OG_HEIGHT } from "../server/og-render.mjs";

// The embedded copy is the OG renderer's only asset source in the worker
// bundle (its disk reads throw there). It must stay byte-identical to the
// og/ files the Node server reads; regenerate with `npm run build:og-assets`.
const FILES = ["atlas.json", "atlas-inter-24.png", "atlas-inter-32.png", "atlas-inter-48.png", "base-receipt.png"];

test("embedded og assets are byte-identical to the og/ files", () => {
  const names = Object.keys(EMBEDDED_OG_ASSETS).sort();
  assert.deepEqual(names, [...FILES].sort(), `embedded asset set drifted (enumerated: \`n = ${FILES.length}\`)`);
  for (const name of FILES) {
    const onDisk = readFileSync(new URL(`../og/${name}`, import.meta.url));
    assert.deepEqual(decodeBase64(EMBEDDED_OG_ASSETS[name]), new Uint8Array(onDisk), `${name}: embedded copy differs from og/${name} — re-run npm run build:og-assets`);
  }
});

test("embedded og assets assemble into a renderable asset set", () => {
  const { atlas, bitmaps, base } = loadEmbeddedOgAssets();
  assert.deepEqual(Object.keys(bitmaps).sort(), ["24", "32", "48"]);
  assert.equal(atlas.sizes["48"].file, "atlas-inter-48.png");
  assert.equal(base.length, OG_WIDTH * OG_HEIGHT * 4);
});
