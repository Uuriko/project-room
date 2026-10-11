// .form-hint overflow: the magic-sent (signin.copy.012) and reset-sent
// (signin.copy.008) templates interpolate the raw user email (maxlength 254,
// no natural wrap points). Without overflow-wrap the hint overflows the auth
// panel and the page scrolls horizontally at 360px. Sibling .status banners
// already carry overflow-wrap: anywhere (src/styles.css); this pins the same
// contract for auth-panel hints. Bug found by worker 1 (sign-in 360px).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "login-polish.css"),
  "utf8",
);

function declarationsFor(selector) {
  const blocks = [];
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  let match;
  while ((match = pattern.exec(css)) !== null) blocks.push(match[1]);
  return blocks;
}

test("#auth-panel .form-hint breaks long interpolated emails", () => {
  const blocks = declarationsFor("#auth-panel .form-hint");
  assert.ok(blocks.length > 0, "expected a #auth-panel .form-hint rule in src/login-polish.css");
  assert.ok(
    blocks.some(block => /overflow-wrap\s*:\s*(anywhere|break-word)/.test(block)),
    "the rule must declare overflow-wrap: anywhere (or break-word)",
  );
});
