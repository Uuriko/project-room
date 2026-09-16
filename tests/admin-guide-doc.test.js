// O002: admin guide exists with expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("ADMIN-GUIDE.md exists with core sections", () => {
  const path = join(root, "docs", "ADMIN-GUIDE.md");
  assert.ok(existsSync(path), "docs/ADMIN-GUIDE.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## Deployment", "## Backup", "## Configuration"]) {
    assert.ok(content.includes(section), `Guide should include ${section}`);
  }
});
