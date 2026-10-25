// Phone inputs under 16px make iOS Safari zoom on focus. The floor is
// the 1rem text token (16px at the default root) and applies only under
// 768px, so the desktop sizes stay as written.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(join(root, "src/styles.css"), "utf8");
const a11y = readFileSync(join(root, "src/public-a11y.css"), "utf8");

test("inputs, selects, and textareas are 16px under 768px and desktop rules stay", () => {
  const block = styles.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/);
  assert.ok(block, "expected one max-width 768px block");
  const body = block[1];
  for (const selector of ["input", "select", "textarea", ".account-room-form input", ".spend-allowance-form input"]) {
    assert.match(body, new RegExp(selector.replace(/[.]/g, "\\.")), selector);
  }
  assert.match(body, /font-size:\s*var\(--text-md\)/);
  assert.match(styles, /--text-md:1rem/);
  assert.match(styles, /\.account-room-form input, \.account-room-form textarea, \.account-room-form select \{[^}]*font:\s*inherit/);
  assert.match(styles, /\.spend-allowance-form input \{[^}]*font:\s*inherit/);
});

test("404 and invite-not-found links declare a 24px target", () => {
  assert.match(a11y, /\.public-error-nav a \{[^}]*min-height:\s*24px/);
});
