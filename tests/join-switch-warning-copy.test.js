// A27: the join dialog's switch warning used to read "Joining may change
// your identity and clear unsent drafts" - vague about what actually
// happens. The copy now says it plainly: a guest join, named, with the
// account untouched - and keeps the accurate unsent-drafts warning.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const html = read("../index.html");
const shareLinks = read("../src/share-links.js");

test("join switch warning names the guest and keeps the account intact", () => {
  assert.ok(!html.includes("may change your identity"), "old vague warning is gone from the shell");
  const fallback = html.match(/<p id="join-switch-warning"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(fallback, "index.html keeps #join-switch-warning");
  assert.equal(fallback[1].trim(), "You'll join as a guest. Your account stays the same. Save a copy of unsent drafts first.");
  assert.ok(shareLinks.includes("`You'll join as a guest named ${name}. Your account stays the same. Save a copy of unsent drafts first.`"),
    "typed name is interpolated once known");
  assert.ok(shareLinks.includes('$("#join-link-name").addEventListener("input", updateSwitchWarning)'),
    "warning follows the name as it is typed");
  assert.ok(!shareLinks.includes("may change your identity"), "old vague warning is gone from the flow");
});
