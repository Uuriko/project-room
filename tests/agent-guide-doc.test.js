// O003: agent developer guide exists with expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("AGENT-DEVELOPER-GUIDE.md exists with core sections", () => {
  const path = join(root, "docs", "AGENT-DEVELOPER-GUIDE.md");
  assert.ok(existsSync(path), "docs/AGENT-DEVELOPER-GUIDE.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## Enrollment", "## MCP Interface", "## Inbox Commands",
      "## Best Practices"]) {
    assert.ok(content.includes(section), `Guide should include ${section}`);
  }
});
