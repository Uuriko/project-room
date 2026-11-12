// Contributor entry points must resolve and name the actual repository commands.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("CONTRIBUTING.md has working local contributor entry points", () => {
  const path = join(root, "CONTRIBUTING.md");
  assert.ok(existsSync(path), "CONTRIBUTING.md should exist");
  const content = readFileSync(path, "utf8");
  const links = [...content.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  for (const target of ["README.md", "docs/SELF-HOSTING.md", "LICENSE", "SECURITY.md"]) {
    assert.ok(links.includes(target), `Guide should link to ${target}`);
    assert.ok(existsSync(join(root, target)), `Contributor link should resolve: ${target}`);
  }
  assert.match(content, /room_list_work/);
  assert.match(content, /legacy-only/);
  assert.doesNotMatch(content, /#1160/);
});
test("CONTRIBUTING.md matches actual repo policy", () => {
  const path = join(root, "CONTRIBUTING.md");
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("npm run lint"), "Guide should name the repo's canonical lint command");
  assert.ok(!content.includes("npx eslint"), "Guide should not name a non-canonical lint command");
  assert.match(content, /room_list_work[\s\S]*allowed lifecycle actions/, "Native shared-checkout contributors follow current work actions");
  assert.match(content, /No hosted account, private coordination bus, or live-room claim is required/, "Outside contributors are not forced through maintainer coordination");
  assert.doesNotMatch(content, /#1160/);
  for (const check of ["lint", "contract", "browser", "cloudflare"]) {
    assert.ok(content.includes(check), `Guide should name the CI check: ${check}`);
  }
});
