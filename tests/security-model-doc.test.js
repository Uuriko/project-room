// O007: security model doc exists with expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("SECURITY-MODEL.md exists with core sections", () => {
  const path = join(root, "docs", "SECURITY-MODEL.md");
  assert.ok(existsSync(path), "docs/SECURITY-MODEL.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## Trust boundaries", "## Authentication", "## Authorization", "## Data protection"]) {
    assert.ok(content.includes(section), `Doc should include ${section}`);
  }
});
test("SECURITY-MODEL.md makes no false redaction claims", () => {
  const path = join(root, "docs", "SECURITY-MODEL.md");
  const content = readFileSync(path, "utf8");
  assert.ok(!content.includes("PR #188"), "Doc must not cite unmerged PR #188 as available");
  assert.ok(content.includes("src/data-export.mjs"), "Doc should reference the actual redaction implementation");
});
