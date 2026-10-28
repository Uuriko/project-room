import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

// Regression guard for #2908: the webhook-rotation tests must live in plain,
// reviewable source. They must not be materialized at run time from an
// obfuscated payload that bypasses review, lint, and secret scanning.
test("telegram webhook rotation tests are plain source, not an obfuscated payload", () => {
  assert.equal(
    existsSync(join(dir, ".telegram-webhook-rotation.obf")),
    false,
    "the obfuscated payload file must not exist",
  );
  const source = readFileSync(join(dir, "telegram-webhook-rotation.test.js"), "utf8");
  assert.doesNotMatch(source, /gunzipSync/, "the test file must not gunzip a hidden payload");
  assert.doesNotMatch(source, /\.obf/, "the test file must not reference an obfuscated payload");
  assert.doesNotMatch(source, /\.generated\.mjs/, "the test file must not materialize a generated test file");
  assert.doesNotMatch(source, /\.reverse\(\)/, "the test file must not de-obfuscate code by reversing a string");
  assert.match(
    source,
    /test\("generateWebhookSecret produces crypto-secure secrets/,
    "the rotation tests themselves must be inline in the reviewable test file",
  );
});
