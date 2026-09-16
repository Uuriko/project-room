// F025: multi-region design doc exists with expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("F025-MULTI-REGION-DESIGN.md exists with core sections", () => {
  const path = join(root, "docs", "F025-MULTI-REGION-DESIGN.md");
  assert.ok(existsSync(path), "design doc should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## Goal", "## Architecture", "## Consistency model", "## Open questions"]) {
    assert.ok(content.includes(section), `Doc should include ${section}`);
  }
  assert.ok(content.includes("No build until John asks"));
});
