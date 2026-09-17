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
test("USER-GUIDE.md documents only implemented features", () => {
  const path = join(root, "docs", "USER-GUIDE.md");
  const content = readFileSync(path, "utf8");
  for (const wrong of ["quick search", "Cmd/Ctrl+Enter", "`N` — new work item",
      "Upload files", "dependencies", "Schedule rooms for recurring syncs",
      "auto-extract", "Global search finds", "Save frequent searches"]) {
    assert.ok(!content.includes(wrong), `Guide must not claim unimplemented feature: ${wrong}`);
  }
  assert.ok(content.includes("room actions dialog"), "Guide should document the real Cmd/Ctrl+K behavior");
});
