// Verify the frozen candidate manifest matches the working tree byte-for-byte.
// Run at candidate cuts and during deployment preparation; drift means the
// candidate was never frozen or the tree moved after the freeze.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCandidateManifest, manifestDrift, MANIFEST_PATH } from "./candidate-manifest.mjs";

const root = process.cwd();
let actual;
try { actual = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")); }
catch (error) { console.error(`candidate manifest unreadable: ${error.message}`); process.exit(1); }
const drift = manifestDrift(buildCandidateManifest(root), actual);
if (drift.length) {
  console.error(`candidate manifest drift (${drift.length}):`);
  for (const entry of drift.slice(0, 20)) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`candidate manifest matches the tree: schema ${actual.storeSchemaVersion}, ${Object.keys(actual.assets).length} assets, ${Object.keys(actual.deployment).length} deployment files, ${Object.keys(actual.packages).length} package files`);
