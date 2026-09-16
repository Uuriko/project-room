// O006: contributing guide exists with expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("CONTRIBUTING.md exists with core sections", () => {
  const path = join(root, "CONTRIBUTING.md");
  assert.ok(existsSync(path), "CONTRIBUTING.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## Coordination", "## Workflow", "## Code conventions"]) {
    assert.ok(content.includes(section), `Guide should include ${section}`);
  }
  assert.ok(content.includes("#266"));
});
