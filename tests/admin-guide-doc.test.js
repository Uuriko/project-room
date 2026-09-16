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
test("ADMIN-GUIDE.md operational claims match the repo", () => {
  const path = join(root, "docs", "ADMIN-GUIDE.md");
  const content = readFileSync(path, "utf8");
  for (const wrong of ["`worker/`", "GET /health", "test:contract", "wrangler.toml"]) {
    assert.ok(!content.includes(wrong), `Guide must not contain unverified claim: ${wrong}`);
  }
  assert.ok(content.includes("GET /api/health"), "Guide should document the real health endpoint");
  assert.ok(content.includes("production` branch"), "Guide should name the real live lineage");
});
