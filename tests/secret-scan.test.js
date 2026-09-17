// H005: secret scanning. Pure detector tests; no file writes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { scanText, scanLines, SecretScanError } from "../server/secret-scan.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SecretScanError && error.code === code);
// All example secrets are generated at runtime so this file never contains
// a literal secret-shaped string (GitHub push protection).
const fakeAwsKey = () => "AKIA" + randomBytes(12).toString("hex").toUpperCase().slice(0, 16);
const fakeStripeKey = () => "sk_test_" + randomBytes(16).toString("hex");

test("known secret patterns are found with redacted previews", () => {
  const awsKey = fakeAwsKey(), stripeKey = fakeStripeKey();
  const findings = scanText(`key = "${awsKey}"\napi_key: "${stripeKey}"\nhello world`);
  assert.equal(findings.length, 3); // line 2 matches both generic-api-key and stripe-key
  assert.deepEqual(findings.map(f => f.rule), ["aws-access-key", "generic-api-key", "stripe-key"]);
  assert.deepEqual(findings.map(f => f.line), [1, 2, 2]);
  assert.ok(!findings[0].preview.includes(awsKey), "preview must be redacted");
  assert.ok(Object.isFrozen(findings));
});
test("high-entropy strings are flagged; allowlist suppresses", () => {
  const secret = randomBytes(32).toString("base64url"); // 43 chars, entropy ~5.3
  const findings = scanLines([`deployed ${secret} ok`, "just a normal sentence here"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "high-entropy");
  const allowed = scanLines([`deployed ${secret} ok`], { allowlist: [new RegExp(secret.slice(0, 8))] });
  assert.equal(allowed.length, 0);
});
test("clean text yields no findings", () => {
  assert.deepEqual(scanText("hello world\nnothing to see here"), []);
});
test("malformed inputs are refused", () => {
  throwsCode(() => scanText(42), "invalid_secret_scan");
  throwsCode(() => scanLines("nope"), "invalid_secret_scan");
  throwsCode(() => scanText("x", { allowlist: ["not a regex"] }), "invalid_secret_scan");
});
