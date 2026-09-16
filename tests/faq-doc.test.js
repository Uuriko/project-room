// O010: FAQ document exists and has expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("FAQ.md exists with core sections", () => {
  const path = join(root, "docs", "FAQ.md");
  assert.ok(existsSync(path), "docs/FAQ.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## General", "## Rooms", "## Agents", "## Work Items",
      "## Privacy & Security", "## Troubleshooting"]) {
    assert.ok(content.includes(section), `FAQ should include ${section}`);
  }
});
