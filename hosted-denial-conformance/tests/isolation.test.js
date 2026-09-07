import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenPaths = [
  "server/http.mjs",
  "server/store.mjs",
  "server/share-links.mjs",
  "src/app.js",
  "cloudflare/room.mjs",
  "cloudflare/hosted-check.mjs"
];

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collect(path));
      continue;
    }
    if (/\.(js|mjs|md|json)$/.test(entry.name)) {
      files.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  return files;
}

test("package stays in hosted-denial-conformance/ and does not import Codex / Phase 0 paths", () => {
  for (const file of collect(join(root, "src"))) {
    assert.doesNotMatch(file.text, /from ["'][^"']*\/server\//);
    assert.doesNotMatch(file.text, /from ["'][^"']*\/src\//);
    assert.doesNotMatch(file.text, /from ["'][^"']*cloudflare\//);
    assert.doesNotMatch(file.text, /from ["'][^"']*conformance-pilot/);
    for (const forbidden of forbiddenPaths) {
      assert.doesNotMatch(file.text, new RegExp(`from ["'][^"']*${forbidden.replaceAll(".", "\\.")}`));
    }
  }
});

test("readme names the isolation and no-merge constraints", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const path of forbiddenPaths) {
    assert.match(readme, new RegExp(path.replaceAll(".", "\\.")));
  }
  assert.match(readme, /Does not merge/);
  assert.match(readme, /#8/);
  assert.match(readme, /#23/);
  assert.match(readme, /69e820909876e2d1e0a4aba2fae60261255eec38/);
});
