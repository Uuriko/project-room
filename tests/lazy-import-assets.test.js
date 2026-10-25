// A11Y-LOOP regression guard: every module the client lazy-loads with a
// dynamic import() must be in the server's public asset catalog, or the
// request 404s and the surface never renders in a real browser (this is how
// the Bounties & credits panel shipped dead: src/bounty-board.js was in the
// runtime-package manifest but missing from server/public-assets.mjs, and
// only module-level unit tests exercised it).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicAssetPaths } from "../server/public-assets.mjs";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

test("every dynamic import() target under src/ is a served public asset", () => {
  const served = new Set(publicAssetPaths);
  const missing = [];
  for (const file of readdirSync(srcDir)) {
    if (!/\.(js|mjs)$/.test(file)) continue;
    const source = readFileSync(join(srcDir, file), "utf8");
    for (const match of source.matchAll(/import\(\s*["']\.\/([^"']+)["']\s*\)/g)) {
      const asset = `src/${match[1]}`;
      if (!served.has(asset)) missing.push(`${file} -> ${asset}`);
    }
  }
  assert.deepEqual(missing, [], "lazy-loaded modules missing from server/public-assets.mjs");
});
