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

// Human troubleshooting answers name doc paths in backticks as plain prose,
// which tests/docs-relative-links.test.js does not check (it only follows
// Markdown [text](path) links). A reader who follows a named path to a file
// that does not exist hits a dead end, so every `docs/...` path named in the
// FAQ must resolve to a committed file.
test("FAQ backtick doc-path references resolve to committed files", () => {
  const content = readFileSync(join(root, "docs", "FAQ.md"), "utf8");
  const refs = [...content.matchAll(/`((?:docs|history)\/[^`\s]+\.md)`/g)].map(m => m[1]);
  const missing = refs.filter(ref => !existsSync(join(root, ref)));
  assert.deepEqual(missing, [],
    `FAQ names doc paths that do not exist:\n${missing.join("\n")}`);
});

// The account settings page ships a self-serve "Delete account" control
// (src/account-settings-ui.js deletionSectionHtml); the FAQ must point at
// the real path, not at a workspace admin.
test("FAQ deletion answer names the self-serve Delete account path", () => {
  const content = readFileSync(join(root, "docs", "FAQ.md"), "utf8");
  const section = content.split("### Can I delete my data?")[1]?.split("###")[0] ?? "";
  assert.ok(section.includes("Delete account"),
    "FAQ deletion answer should name the in-app Delete account control");
});
