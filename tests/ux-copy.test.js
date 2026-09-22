// QAU-005 (RC-2026-09-19-083): the post-sign-in inbox empty state must read
// as user-facing product copy — oriented toward a first task/room — never as
// dev-facing fixture/deploy notes ("local fixtures", "bot token and webhook
// secret bindings").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const match = html.match(/<p id="inbox-empty"[^>]*>([\s\S]*?)<\/p>/);
assert.ok(match, "index.html keeps the #inbox-empty empty-state element");
const copy = match[1].trim();

const DEV_FACING = ["fixture", "bot token", "webhook secret", "sample inbox", "bindings", "deployment"];

test("inbox empty state contains no dev-facing fixture/deploy copy", () => {
  for (const term of DEV_FACING) {
    assert.ok(!copy.toLowerCase().includes(term), `banned dev-facing term present: "${term}"`);
  }
});

test("inbox empty state offers a concrete Gmail connection action", () => {
  assert.ok(copy.length > 20, "the empty state says something useful");
  assert.ok(/gmail/i.test(copy), "it names the available email provider");
  assert.ok(/connect/i.test(copy) && /email/i.test(copy), "it explains how email arrives");
});
