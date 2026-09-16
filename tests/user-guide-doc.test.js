// O001: user guide exists with expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("USER-GUIDE.md exists with core sections", () => {
  const path = join(root, "docs", "USER-GUIDE.md");
  assert.ok(existsSync(path), "docs/USER-GUIDE.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## Getting started", "## Core workflows", "## Getting help"]) {
    assert.ok(content.includes(section), `Guide should include ${section}`);
  }
});
