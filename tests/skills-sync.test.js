// The plugin error catalog is generated from skills/. A stale copy must not
// fail the pull-request check; a missing copy still must, because the plugin
// install tree has to contain the file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorsCatalogDrift, skillDrift, writeGeneratedErrorsCatalog } from "../scripts/skills-sync.mjs";

const CATALOG = "project-room/references/errors-catalog.md";

function tree(t) {
  const root = mkdtempSync(join(tmpdir(), "skills-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeCatalog(root, dir, body) {
  const path = join(root, dir, CATALOG);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

test("a stale plugin errors catalog is not skill drift and is rewritten from skills/", t => {
  const root = tree(t);
  const source = join(root, "skills");
  const copy = join(root, "plugins/project-room/skills");
  const body = "# Error-code catalog\n\n## Full code index\n\n| `missing` | 404 |\n";
  writeCatalog(root, "skills", body);
  writeCatalog(root, "plugins/project-room/skills", "stale catalog\n");
  assert.deepEqual(skillDrift(source, copy), []);
  assert.equal(writeGeneratedErrorsCatalog(root), true);
  assert.equal(readFileSync(join(copy, CATALOG), "utf8"), body);
  assert.equal(writeGeneratedErrorsCatalog(root), false);
});

test("a missing plugin errors catalog is still drift", t => {
  const root = tree(t);
  const source = join(root, "skills");
  const copy = join(root, "plugins/project-room/skills");
  writeCatalog(root, "skills", "# Error-code catalog\n\n## Full code index\n");
  mkdirSync(copy, { recursive: true });
  const drift = skillDrift(source, copy);
  assert.ok(drift.some(line => line.includes("errors-catalog.md")), drift.join("; "));
});

test("errors catalog check reads the skills source, not the plugin copy", t => {
  const root = tree(t);
  writeCatalog(root, "skills", "# Error-code catalog\n\nno index\n");
  writeCatalog(root, "plugins", "# Error-code catalog\n\n## Full code index\n");
  assert.deepEqual(errorsCatalogDrift(root), ["skills errors catalog is missing the Full code index"]);
});
