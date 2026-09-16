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
test("CONTRIBUTING.md matches actual repo policy", () => {
  const path = join(root, "CONTRIBUTING.md");
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("npm run lint"), "Guide should name the repo's canonical lint command");
  assert.ok(!content.includes("npx eslint"), "Guide should not name a non-canonical lint command");
  assert.ok(content.includes("#266"), "Guide should name the active claims board");
  assert.ok(content.includes("2,500"), "Guide should note why #11 is read-only");
  for (const check of ["lint", "contract", "browser", "cloudflare"]) {
    assert.ok(content.includes(check), `Guide should name the CI check: ${check}`);
  }
});
